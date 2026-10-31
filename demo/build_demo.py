"""
Assemble the demo:  original demo (fraudguard-demo.base.html) + AI Memory engine/UI (src/*.js)

Outputs (identical content):
  demo/fraudguard-demo.html                  open directly in a browser (standalone)
  ../frontend/public/demo/index.html         served by the app at /demo/  (the login page's "Try demo" button)

Idempotent: always starts from the untouched base file.   usage: python build_demo.py [path/to/base.html]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
base = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'fraudguard-demo.base.html')
src = open(base, encoding='utf-8').read()
eng = open(os.path.join(HERE, 'src', 'memory_engine.js'), encoding='utf-8').read()
ui = open(os.path.join(HERE, 'src', 'memory_ui.js'), encoding='utf-8').read()


def once(old, new):
    global src
    assert src.count(old) == 1, f'anchor not found exactly once: {old[:70]!r} (found {src.count(old)})'
    src = src.replace(old, new)


once('</style>', '\n/* --- AI Memory / Fraud Intelligence (added) --- */\nol,ul{margin:6px 0;padding-left:20px}li{margin:3px 0}\ntextarea{width:100%;font:inherit}\n</style>')
once("['cases', 'Cases', 'folder', 1], ['relationships', 'Relationships', 'net', 1], ['profiles', 'Profiles', 'user', 1]]]",
     "['cases', 'Cases', 'folder', 1], ['relationships', 'Relationships', 'net', 1], ['profiles', 'Profiles', 'user', 1], ['memory', 'AI Memory', 'brain', 1]]]")
once("  x: '<circle cx=\"12\" cy=\"12\" r=\"9\"/>",
     "  brain: '<path d=\"M9.5 3A3.5 3.5 0 006 6.5v.3A3.5 3.5 0 004 10a3.5 3.5 0 001.5 2.9A3.5 3.5 0 007 18.5 3.5 3.5 0 0012 20V4.5A1.5 1.5 0 009.5 3zM14.5 3A3.5 3.5 0 0118 6.5v.3A3.5 3.5 0 0120 10a3.5 3.5 0 01-1.5 2.9A3.5 3.5 0 0117 18.5a3.5 3.5 0 01-5 1.5\"/>',\n  x: '<circle cx=\"12\" cy=\"12\" r=\"9\"/>")
once("All data is synthetic and runs entirely in your browser — nothing is sent anywhere.",
     "All data is synthetic and runs entirely in your browser — nothing is sent anywhere (unless you explicitly connect the optional live backend in AI Memory).")
# "Exit demo" links: only when the app serves this page under /demo/ (a standalone file has nowhere to exit to)
once('<a onclick="ACT.reset()">Reset demo data</a></span>', '<a onclick="ACT.reset()">Reset demo data</a>${EXIT_LINK}</span>')
once("Analysts don't — role-based access control.</p>",
     "Analysts don't — role-based access control.${EXIT_LINK ? '<br><a href=\"' + APP_BASE + 'login\">← Back to FraudGuard sign in</a>' : ''}</p>")
prelude = ("const APP_BASE = location.pathname.replace(/demo\\/?(index\\.html)?$/, '');  // '/' when the app is at the site root\n"
           "const EXIT_LINK = /^https?:$/.test(location.protocol) && /\\/demo\\/?(index\\.html)?$/.test(location.pathname)"
           " ? ' &nbsp;·&nbsp; <a href=\"' + APP_BASE + 'login\">Exit demo</a>' : '';\n")
once("S.me = null; render();", prelude + eng + "\n" + ui + "\nS.me = null; render();")

targets = [os.path.join(HERE, 'fraudguard-demo.html'), os.path.join(HERE, '..', 'frontend', 'public', 'demo', 'index.html')]
for t in targets:
    os.makedirs(os.path.dirname(t), exist_ok=True)
    open(t, 'w', encoding='utf-8').write(src)
print('built', len(src), 'bytes ->', ', '.join(os.path.relpath(t, HERE) for t in targets))
