# Records assets/demo.gif: a real run of `mnemosy demo` from npm next, nothing staged.
# Regenerate with `vhs assets/demo.tape` from the repository root (vhs >= 0.12).
Output assets/demo.gif

Set Shell "bash"
Set FontSize 17
Set Width 1200
Set Height 600
Set Padding 24
Set LineHeight 1.25
Set TypingSpeed 35ms
Set Framerate 20
Set CursorBlink false
Set WindowBar Colorful
Set Theme { "name": "Mnemosyne", "background": "#070b12", "foreground": "#edf2f9", "cursor": "#b8f6dd", "selection": "#263141", "black": "#111b2a", "red": "#ff8a8a", "green": "#b8f6dd", "yellow": "#f3d98b", "blue": "#9abfff", "magenta": "#c9b6ff", "cyan": "#9fe3f0", "white": "#edf2f9", "brightBlack": "#9aa9be", "brightRed": "#ffadad", "brightGreen": "#d4fbe9", "brightYellow": "#f8e7b3", "brightBlue": "#bdd5ff", "brightMagenta": "#ddd0ff", "brightCyan": "#c4eff7", "brightWhite": "#ffffff" }

Hide
Type "export PS1='$ ' && cd $(mktemp -d) && clear"
Enter
Sleep 500ms
Show

Type "npx -y -p mnemosy-ai@next mnemosy demo | tee demo.log"
Sleep 400ms
Enter
Sleep 6s
Sleep 2s

Type "clear; grep -E '^PROOF|moments proved' demo.log"
Sleep 300ms
Enter
Sleep 9s
