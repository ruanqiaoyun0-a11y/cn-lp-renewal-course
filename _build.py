# -*- coding: utf-8 -*-
"""
_build.py — 组装 index.html
用法：python _build.py [--check]
  --check  只校验，不写文件
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import _content as C  # noqa: E402

OUT = os.path.join(HERE, 'index.html')
CHECK_ONLY = '--check' in sys.argv


def read(name):
    with open(os.path.join(HERE, name), 'r', encoding='utf-8') as f:
        return f.read()


def build_app_data():
    return {
        'title': C.COURSE_TITLE,
        'lsPrefix': C.LS_PREFIX,
        'orgName': C.ORG_NAME,
        'aiBaseUrl': 'https://api.xiaomimimo.com/v1',
        'aiModel': 'mimo-v2.5-pro',
        'allowedHosts': ['ruanqiaoyun0-a11y.github.io', 'localhost', '127.0.0.1'],
        'sections': C.SECTIONS,
        'chapterQuizzes': C.CHAPTER_QUIZZES,
        'levelLibrary': C.LEVEL_LIBRARY,
        'finalSystemPrompt': C.FINAL_SYSTEM_PROMPT,
        'scoringPrompt': C.SCORING_PROMPT,
        'fallbackReplies': C.FALLBACK_REPLIES,
        'topicTags': C.TOPIC_TAGS,
        'ch6WritingDrills': C.CH6_WRITING_DRILLS,
    }


HEAD = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="面向线上少儿数学思维班主任（LP）的《续费全流程实战》互动微课">
<title>{title} · 班主任微课</title>
<style>
{css}
</style>
</head>
'''


def main():
    css = read('_shell.css') + '\n' + read('_additions.css')
    shell = read('_shell.html')
    js = read('_app.tpl.js')
    app = build_app_data()

    # 关键断言：JSON 里若含 </script 会截断 script 标签
    data_json = json.dumps(app, ensure_ascii=False, separators=(',', ':'))
    assert '</script' not in data_json.lower(), 'JSON 中包含 </script，需转义处理'

    html = (
        HEAD.format(title=C.COURSE_TITLE, css=css)
        + shell
        + '\n<!-- ===== 课程数据（JSON） ===== -->\n'
        + '<script id="appDataJson" type="application/json">' + data_json + '</script>\n'
        + '\n<!-- ===== 应用逻辑 ===== -->\n'
        + '<script>\n' + js + '\n</script>\n'
        + '</body>\n</html>\n'
    )

    # ---------- 校验 ----------
    problems = []
    if re.search(r'\{\{[A-Z_]+\}\}', html):
        problems.append('存在未替换的 {{PLACEHOLDER}} 占位符')
    if '<script' not in html or '</script>' not in html:
        problems.append('script 标签缺失')
    if 'quiz-locked-hint' not in html:
        problems.append('缺少串行锁定样式/提示')
    if 'levelLibrary' not in html:
        problems.append('缺少第 6 章 S1-S9 速查库挂载点 #levelLibrary')
    if 'ch6WritingDrills' not in html:
        problems.append('缺少第 6 章写作练习挂载点 #ch6WritingDrills')
    if 'roleplayContainer' not in html:
        problems.append('缺少终极考核挂载点')
    # 章节数断言：v1.3 起 7 章（学习反馈复习引导 / 终极考核各自独立成章）
    if len(C.SECTIONS) != 7:
        problems.append('章节数不为 7（当前 %d）' % len(C.SECTIONS))
    if 'roleplayContainer' not in C.CH7:
        problems.append('roleplayContainer 应位于第 7 章（CH7）内容中')
    if 'roleplayContainer' in C.CH6:
        problems.append('roleplayContainer 不应再出现在第 6 章（CH6）内容中')
    if 'placeholder="MIMO_API_KEY"' in html:
        problems.append('异常：出现密钥占位串')
    if "'__MIMO_API_KEY__'" not in html:
        problems.append('缺少密钥注入占位符 __MIMO_API_KEY__（_build.js 需要）')
    # 章节 / 题目数量：题目 DOM 由 JS 运行时生成，校验生成模板与数据条数
    if "chquiz-' + chIdx + '-' + qi" not in js:
        problems.append('缺少题目 DOM 生成模板')
    if "feedback-chquiz-' + chIdx + '-' + qi" not in js:
        problems.append('缺少题目反馈 DOM 生成模板')
    for i, qs in enumerate(C.CHAPTER_QUIZZES):
        if not isinstance(qs, list):
            problems.append('第 %d 章测验数据格式错误' % (i + 1))
        for qi, q in enumerate(qs):
            if not all(k in q for k in ('q', 'opts', 'correct')):
                problems.append('第 %d 章第 %d 题字段缺失' % (i + 1, qi + 1))
            elif not (0 <= q['correct'] < len(q['opts'])):
                problems.append('第 %d 章第 %d 题 correct 越界' % (i + 1, qi + 1))
    # 第 4 章题量断言：3 道流程题 + 3 道带付话术题（v1.2.1 由填空题改造而来）
    if len(C.CHAPTER_QUIZZES[3]) != 6:
        problems.append('第 4 章测验题数不为 6（当前 %d）' % len(C.CHAPTER_QUIZZES[3]))
    # 九级速查库校验
    if len(C.LEVEL_LIBRARY) != 9:
        problems.append('S1-S9 速查库级别数不为 9（当前 %d）' % len(C.LEVEL_LIBRARY))
    for lv in C.LEVEL_LIBRARY:
        if not all(k in lv for k in ('level', 'grade', 'position', 'stuck', 'build', 'change')):
            problems.append('速查库 %s 字段缺失' % lv.get('level', '?'))
    if 'level-card' not in js:
        problems.append('缺少速查库折叠卡片渲染模板')

    # ---------- 残留扫描：填空题已整体移除（v1.2.1），任何相关残留都说明清理不干净 ----------
    for residue in ('fillQuizContainer', 'fillInput-', 'submitFill', 'renderFillQuiz',
                    'fillAllDone', 'restoreFillUI', 'fillAnswers', 'fillDone',
                    'finalFills', 'normFill', 'fill-card', 'fill-input',
                    'content_quiz_fill', 'CH4_FILLS', '填空'):
        if residue in js:
            problems.append('JS 中残留填空题相关代码：%s' % residue)
        if residue in html.replace(js, ''):
            problems.append('HTML/数据中残留填空题相关内容：%s' % residue)
    if not hasattr(C, 'CH4_FILLS'):
        pass  # 期望状态：_content.py 中 CH4_FILLS 已删除
    else:
        problems.append('_content.py 中仍存在 CH4_FILLS，应整体删除')

    # ---------- 残留扫描：四段阶梯实战演练已整体移除（v1.3），任何残留都说明清理不干净 ----------
    for residue in ('ch6ScenarioTabs', 'ch6DialogueScenarios', 'CH6_DIALOGUE_SCENARIOS',
                    'renderCh6ScenarioTabs', 'switchScenarioTab', 'renderScenarioBody',
                    'startScenario', 'sendScenarioMessage', 'endScenario', 'scoreScenario',
                    'resetScenario', 'restoreScenarioUI', 'updateScenarioTopic',
                    'getScenarioFallback', 'scState', 'scMeta', 'scenarioActiveTab'):
        if residue in js:
            problems.append('JS 中残留四段演练相关代码：%s' % residue)
        if residue in html.replace(js, ''):
            problems.append('HTML/数据中残留四段演练相关内容：%s' % residue)
    if not hasattr(C, 'CH6_DIALOGUE_SCENARIOS') and not hasattr(C, '_YANGYANG_BG'):
        pass  # 期望状态：演练数据与共用背景已整体删除
    else:
        problems.append('_content.py 中仍存在 CH6_DIALOGUE_SCENARIOS / _YANGYANG_BG，应整体删除')
    # 洋阳 → 洋洋 改名断言：课程所有交付文本中不得再出现「洋阳」
    for name, text in (('content', '\n'.join(str(s.get('content', '')) for s in C.SECTIONS)),
                       ('js', js)):
        if '洋阳' in text:
            problems.append('%s 中残留旧人名「洋阳」（应为「洋洋」）' % name)

    # 终极考核聊天：泛化函数 + 兼容层必须同时存在
    if 'function renderChatMessage' not in js:
        problems.append('缺少通用聊天渲染函数 renderChatMessage')
    if 'function renderFinalMessage' not in js:
        problems.append('缺少终极考核兼容层 renderFinalMessage')
    if 'function showChatTyping' not in js:
        problems.append('缺少通用打字指示函数 showChatTyping')

    # ---------- 第 6 章 · 三轮话术写作练习 ----------
    if len(C.CH6_WRITING_DRILLS) != 3:
        problems.append('写作练习数不为 3（当前 %d）' % len(C.CH6_WRITING_DRILLS))
    for wd in C.CH6_WRITING_DRILLS:
        need = ('id', 'title', 'scene', 'student_info', 'task', 'min_len',
                'placeholder', 'dims', 'ref_answer', 'ref_tips')
        if not all(k in wd for k in need):
            problems.append('写作练习 %s 字段缺失' % wd.get('id', '?'))
            continue
        if len(wd['dims']) != 5:
            problems.append('写作练习 %s 维度数不为 5' % wd['id'])
        if sum(d['max'] for d in wd['dims']) != 100:
            problems.append('写作练习 %s 维度总分不为 100' % wd['id'])
        for dim in wd['dims']:
            if not dim.get('kw'):
                problems.append('写作练习 %s 维度「%s」缺少关键词' % (wd['id'], dim.get('name', '?')))
        if wd['min_len'] < 50:
            problems.append('写作练习 %s 最少字数偏低' % wd['id'])
    if 'renderWritingDrills' not in js:
        problems.append('缺少写作练习渲染函数')
    if 'submitWriting' not in js:
        problems.append('缺少写作练习提交函数')
    if 'restoreWritingUI' not in js:
        problems.append('缺少写作练习状态恢复函数')

    # ---------- 练习区红线：不得出现通过线 / 未通过措辞 ----------
    for bad in ('需≥60分', '总分不足60', '未通过（', '不达标，请重新'):
        if bad in js:
            problems.append('第 6 章练习区出现门槛/未通过措辞：%s' % bad)

    # ---------- 终评维度标签存在性断言（复制课程时最容易漏改） ----------
    for label in ('流程规范性 /30', '信息准确性 /30', '服务亲和力 /25', '话题覆盖度 /15'):
        if label not in js:
            problems.append('终极考核终评维度标签缺失：%s' % label)

    # 明文密钥
    if re.search(r'sk-[A-Za-z0-9]{20,}', html):
        problems.append('严重：index.html 中出现明文密钥 sk-...')

    print('章节数：', len(C.SECTIONS), '（第 6 章学习反馈与复习引导 / 第 7 章终极考核）')
    print('选择题总数：', sum(len(x) for x in C.CHAPTER_QUIZZES),
          '（各章：', '/'.join(str(len(x)) for x in C.CHAPTER_QUIZZES), '）')
    print('九级速查库：', len(C.LEVEL_LIBRARY), '级（重点 S5/S6/S7）')
    print('第 6 章写作练习：', len(C.CH6_WRITING_DRILLS), '道',
          '（维度总分：', '/'.join(str(sum(d['max'] for d in w['dims'])) for w in C.CH6_WRITING_DRILLS), '）')
    print('index.html 字节数：', len(html.encode('utf-8')))
    if problems:
        print('\n❌ 校验未通过：')
        for p in problems:
            print('  -', p)
        sys.exit(1)
    print('✅ 校验通过')

    if CHECK_ONLY:
        print('（--check 模式，未写文件）')
        return
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('已写出：', OUT)


if __name__ == '__main__':
    main()
