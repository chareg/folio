import re
# Regenerates web/index.html and app/index.html from tools/web-template.html.
# Run from the repo root: python3 tools/make_desktop.py
import base64, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
sample = base64.b64encode(open(ROOT + 'tools/sample.docx', 'rb').read()).decode()
t = open(ROOT + 'tools/web-template.html').read().replace('__SAMPLE__', sample)
EDITOR = ['app/editor/model.js', 'app/editor/editor.js']
assert t.count('<!--FOLIO-EDITOR-->') == 1
# The browser version is one self-contained file; the desktop app loads the scripts from app/editor/.
web = t.replace('<!--FOLIO-EDITOR-->', '\n'.join('<script>\n' + open(ROOT + f).read().replace('</script', '<\\/script') + '\n</script>' for f in EDITOR))
open(ROOT + 'web/index.html', 'w').write(web)
d=t.replace('<!--FOLIO-EDITOR-->', '\n'.join('<script src="%s"></script>' % f[len('app/'):] for f in EDITOR))
d=re.sub(r'<link rel="preconnect"[^>]*>\n','',d)
d=re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>','<link rel="stylesheet" href="fonts.css">',d)
d=d.replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
d=d.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>','<script src="vendor/jszip.min.js"></script>')
d=d.replace('<script src="https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js"></script>','<script src="vendor/mammoth.browser.min.js"></script>')
d=d.replace('''        <button data-width="80ch">Wide</button>
      </div>
    </div>
  </div>''','''        <button data-width="80ch">Wide</button>
      </div>
    </div>
    <div class="about">
      <div class="about-row">
        <span class="about-name"><i>Folio</i> <span id="appVersion"></span></span>
        <button class="upd-btn" id="updBtn">Check for updates</button>
      </div>
      <p class="upd-msg" id="updMsg" role="status" hidden></p>
    </div>
  </div>''',1)
d=d.replace('<button class="icon-btn" id="focusBtn"','<button class="upd-pill" id="updPill" hidden title="A new version of Folio is ready">Restart to update</button>\n    <button class="icon-btn" id="focusBtn"',1)
assert 'updPill' in d and 'appVersion' in d
assert 'googleapis' not in d and 'cdn' not in d.split('<script src="vendor')[0][-300:]
desk_css='''<style>
[hidden] { display: none !important; }
body { margin: 0; }
img { max-width: 100%; }
html.desktop .bar {
  -webkit-app-region: drag; user-select: none;
  padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px);
}
html.desktop .bar button, html.desktop .bar input, html.desktop .pop { -webkit-app-region: no-drag; }
html.desktop .pop { right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px); }
html.desktop .wordmark { padding-left: 4px; }
html.desktop body { overflow-y: scroll; }
html.desktop ::-webkit-scrollbar { width: 12px; }
html.desktop ::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 8px; border: 3px solid var(--bg); }
html.desktop ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
html.desktop ::-webkit-scrollbar-track { background: transparent; }
.about { border-top: 1px solid var(--rule); padding-top: 14px; display: grid; gap: 8px; }
.about-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.about-name { color: var(--muted); font-variant-numeric: tabular-nums; }
.about-name i { font-family: var(--serif); font-size: 16px; color: var(--fg); margin-right: 2px; }
.upd-btn {
  border: 1px solid var(--rule); background: var(--bg); color: var(--fg); border-radius: 9px;
  padding: 7px 12px; cursor: pointer; font-weight: 500; font-size: 12.5px;
}
.upd-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.upd-btn:disabled { opacity: .6; cursor: default; }
.upd-msg { margin: 0; color: var(--fg-soft); font-size: 12.5px; line-height: 1.45; }
.upd-msg.err { color: var(--accent); }
.upd-pill {
  height: 32px; padding: 0 14px; margin-right: 6px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--accent); color: var(--bg); font-weight: 600; font-size: 12.5px;
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent);
  animation: pulse 2.4s ease-out 3;
}
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
</style>'''
desk_js='''<script>
(function () {
  var D = window.folioDesktop, F = window.__folio;
  if (!D || !F) return;
  document.documentElement.classList.add("desktop");
  function toBuf(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }
  D.onOpenFile(function (f) { F.openBuffer(toBuf(f.bytes), f.name, { path: f.path, mtimeMs: f.mtimeMs }); });
  document.getElementById("openBtn").onclick = function () { D.openDialog(); };
  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); e.stopImmediatePropagation(); D.openDialog(); }
    if (e.key === "F11") { e.preventDefault(); D.toggleFullscreen(); }
  }, true);
  function syncTitleBar() {
    var cs = getComputedStyle(document.documentElement);
    D.setTitleColors({
      color: cs.getPropertyValue("--bg").trim(),
      symbolColor: cs.getPropertyValue("--fg-soft").trim(),
      height: parseInt(cs.getPropertyValue("--bar-h"), 10) || 56
    });
  }
  window.addEventListener("folio:prefs", function () { requestAnimationFrame(syncTitleBar); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTitleBar);
  matchMedia("(max-width: 640px)").addEventListener("change", syncTitleBar);
  syncTitleBar();

  /* ---------- updates ---------- */
  var btn = document.getElementById("updBtn"), msg = document.getElementById("updMsg"), pill = document.getElementById("updPill");
  var manual = false;
  if (D.getVersion) D.getVersion().then(function (v) { document.getElementById("appVersion").textContent = v; });
  function say(text, isErr) { msg.textContent = text; msg.hidden = !text; msg.classList.toggle("err", !!isErr); }
  function onStatus(s) {
    switch (s.state) {
      case "checking":
        if (manual) { btn.disabled = true; btn.textContent = "Checking\u2026"; say(""); }
        break;
      case "current":
        btn.disabled = false; btn.textContent = "Check for updates";
        if (manual) say("You have the latest version.");
        manual = false; break;
      case "downloading":
        btn.disabled = true; btn.textContent = "Downloading\u2026";
        say("Version " + (s.version || "") + " is downloading" + (s.percent != null ? " (" + Math.round(s.percent) + "%)" : "") + ". You can keep reading.");
        break;
      case "ready":
        btn.disabled = false; btn.textContent = "Restart to update";
        btn.onclick = install;
        say("Version " + s.version + " is ready. Folio will restart and reopen in a moment.");
        pill.hidden = false; manual = false; break;
      case "dev":
        btn.disabled = false; btn.textContent = "Check for updates";
        say("Updates work in the installed app only."); manual = false; break;
      case "error":
        btn.disabled = false; btn.textContent = "Check for updates";
        if (manual) say("Couldn\u2019t check for updates. Make sure you\u2019re online, then try again.", true);
        manual = false; break;
    }
  }
  if (D.onUpdateStatus) D.onUpdateStatus(onStatus);
  btn.onclick = function () { manual = true; D.checkForUpdates(); };
  // Restarting would lose unsaved edits, so ask first.
  function install() {
    var ask = F.editor ? F.editor.confirmDiscard("want to restart to update") : Promise.resolve(true);
    ask.then(function (go) { if (go) D.installUpdate(); });
  }
  pill.onclick = install;
})();
</script>'''
csp='<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data: blob:; style-src \'self\' \'unsafe-inline\'; script-src \'self\' \'unsafe-inline\'; font-src \'self\'; connect-src \'self\' data: blob:">'
head='<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'+csp+'\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
# split title+style (head) from body
i=d.index('</style>')+len('</style>')
d=head+d[:i]+'\n'+desk_css+'\n</head>\n<body>\n'+d[i:]+'\n'+desk_js+'\n</body>\n</html>\n'
open(ROOT + 'app/index.html', 'w').write(d)
print('ok', len(d))
