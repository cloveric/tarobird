# TaroBot agent skills

Opt-in skills the bots' engines (Claude Code / Codex) can use. Each skill is a
`SKILL.md` discovered from the **user-level** skill dirs (`~/.claude/skills/` and
`~/.codex/skills/`), and the shared `~/.agents/skills` directory. Discovery depends on the engine
and its current session; copying a skill does not prove it was loaded or used.

The files here are the source of truth (version-controlled); an install script
copies complete skill folders, including referenced resources, into those directories:

```bash
bash scripts/install-skills.sh
```

Runtime prerequisites, where needed, are installed by each skill-specific script.
The general installer does not remove obsolete user-installed skill copies.

## scrapling — anti-bot web scraping

Cloudflare/Turnstile bypass, stealth + JS-render + spider crawl, via the
`scrapling` CLI. The bot escalates to it when `web_extract` is blocked or the
page is dynamic/protected (the routing ladder lives in the skill's "When to use"
section). Install / update:

```bash
bash scripts/install-scrapling.sh
```

(creates a Python venv, installs Scrapling + browser deps, symlinks `scrapling`
onto PATH, copies the skill into both engines). The fetching reference is adapted
from the [Hermes-agent](https://github.com/NousResearch/hermes-agent) `scrapling`
skill (MIT); the tool-routing section is TaroBot-specific.

## tarobot-release-artifacts — unindexed native builds

Temporary App storage and safe post-publication retirement. Install through the
same script above; see [the operator guide](../docs/macos-artifact-retention.md).

## Workbench presentations

Workbench presentations need no skill. Bots use TaroBird's built-in slide format
directly through `app_workbench` / `tarobot workbench run`; shared App/CLI
capability guidance describes it to supported engines without relying on global
skill discovery. Both former Baoyu adapters are gone: `baoyu-design` with its
canvas editor (#89; canvas projects kept from earlier versions can only be
exported in the App) and `baoyu-ppt` with the Baoyu slides editor (#90). The
installer does not remove copies of them that a user installed earlier.

To install into an engine-specific skill location, pass
`--destination /path/to/skills` to `scripts/install-skills.sh` (repeat for
multiple locations). Existing sessions may cache their catalog; do not reset user
conversations just to refresh metadata.
