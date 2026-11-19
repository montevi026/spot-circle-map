@echo off
chcp 65001 > nul
cd /d "%~dp0"
python -c "import server, json; print(json.dumps(server.publish(), ensure_ascii=False))"
if errorlevel 1 (echo アップロードに失敗しました) else (echo アップロードしました。反映まで 1〜2 分かかります)
pause
