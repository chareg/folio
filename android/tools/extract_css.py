"""Prints Folio's reader stylesheet (themes, type, document styles) from the shared
web template, so the Android app always matches the desktop and web moods.
Usage: python3 tools/extract_css.py ../tools/web-template.html > out.css"""
import sys
src = open(sys.argv[1], encoding="utf-8").read()
start = src.index("<style>") + len("<style>")
end = src.index("/* ---------- Edit mode", start)
print("/* Generated from tools/web-template.html by android/tools/extract_css.py. Don't edit here. */")
print(src[start:end].strip())
