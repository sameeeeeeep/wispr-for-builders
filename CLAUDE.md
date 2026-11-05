# For Claude: installing Wispr for Builders

If the person asks you to "install Wispr for Builders" (pack 1, or any mod in it):

1. Check this is a Mac (`uname` is Darwin) and that `node` and `claude` are on PATH. wispr-wish and
   wispr-video also want `ffmpeg` and `whisper-cpp` (`brew install ffmpeg whisper-cpp`); say so if
   they are missing, and carry on with the rest.
2. Tell them in one line what will happen: it links small commands into `~/.wispr-*/bin`, registers
   the mods with each other, starts a local review inbox on 127.0.0.1:4377, and installs the Claude
   Code plugins from this folder. Nothing is uploaded.
3. Run `./install.sh` from this folder (or `./install.sh wispr-file wispr-pm` for only some mods).
4. Walk them through the one manual step: load `plugins/wispr-review/extension` as an unpacked
   extension in chrome://extensions.
5. Suggest one thing to say for each mod they installed (the list install.sh prints at the end).

Do not edit files under `plugins/` while installing.
