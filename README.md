# bsb-anims tooling

This orphan branch owns the Python generator and validator for the [`main`](https://github.com/lxdb/bsb-anims/tree/main) animation catalog. It does not own animation sources or the website.

## Requirements

- Python 3.12 or newer
- Pillow from `requirements.txt`

## Use

From this worktree, point the command at a separate `main` worktree:

```sh
python3 cataloggen.py generate --repo /absolute/path/to/bsb-anims-main
python3 cataloggen.py check --repo /absolute/path/to/bsb-anims-main
python3 -m unittest discover -s tests
```

`generate` validates all source artifacts before replacing any generated file. It writes `theme.json`, renders `preview.gif`, updates catalog hashes and sizes, and regenerates the README catalog region.

`check` builds the same outputs in memory and fails on drift without changing the target repository.

## Ownership

The exact BUSY Bar device frame is isolated under `third_party/`. Original Python code is MIT-licensed. The device frame remains GPL-2.0-or-later; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
