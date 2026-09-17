#!/usr/bin/env python3
"""把 index.template.html + app.js + 示例数据合成单文件 index.html。

用法：python3 build/build.py   （在仓库根目录执行）
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
tpl = (ROOT / 'build' / 'index.template.html').read_text('utf-8')
js = (ROOT / 'build' / 'app.js').read_text('utf-8')
data = (ROOT / 'sample-data' / 'tickets.json').read_text('utf-8').strip()

assert '__APP_JS__' in tpl and '__SAMPLE_DATA__' in tpl, '模板缺少占位符'
assert '</script' not in data, '示例数据里不能出现 </script>'

html = tpl.replace('__SAMPLE_DATA__', data).replace('__APP_JS__', js)
(ROOT / 'index.html').write_text(html, 'utf-8')
print('已生成 index.html（%d 字节）' % len(html))
