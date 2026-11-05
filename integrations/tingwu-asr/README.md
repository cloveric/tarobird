# Official TaroBot adapter for Aliyun Tingwu

This is TaroBot's reference adapter for long-media cloud transcription. **Do not build a separate adapter per bot.** One machine uses one shared adapter directory; every TaroBot instance points to it with `TINGWU_ASR_DIR`.

## Architecture

- TaroBot owns media download, duration probing, routing, cancellation, local fallback, and transcript injection before engine dispatch.
- Media at or above the configured threshold (900 seconds by default) invokes this adapter.
- The adapter owns OSS upload, signed URL creation, Tingwu offline-task creation and polling, result download, and temporary-object cleanup.
- `transcription.txt` is rebuilt from Tingwu's structured paragraphs and word tokens: repeated words are preserved, English spacing is restored, and speaker labels are added only for multi-speaker results.
- TaroBot passes only a minimal OS/certificate/proxy environment to the child; bot, engine, and cloud credentials are not inherited. This adapter loads Aliyun credentials from its own `.env.local`.
- `SIGTERM`/`SIGINT` cancellation cleans up a temporary OSS object before exit. TaroBot still escalates to `SIGKILL` after a bounded grace period if cleanup hangs.
- Tingwu has no local daemon or port. Port `8412` belongs to the optional local Qwen ASR used for short media and cloud fallback.
- Credentials remain in this adapter's `.env.local`; TaroBot never reads or copies them.

## Install

From the TaroBot repository:

```bash
bash scripts/install-tingwu-asr.sh
```

The default target is `~/.tarocub-secrets/tingwu_asr`. The installer copies this official adapter, creates its virtualenv, and installs pinned dependencies. It deliberately does not create `.env.local`, and never overwrites an existing credential file; only the explicit configuration step below writes credentials.

Configure credentials:

```bash
bash ~/.tarocub-secrets/tingwu_asr/configure_env.sh
```

Use a least-privilege RAM user, a Tingwu AppKey, and a dedicated OSS bucket/prefix. Never use a root-account AccessKey or send `.env.local` through chat.
The configurator refuses to overwrite an existing non-empty file. Use `--force` only when you intentionally rotate or replace all values.

For the App, open **Settings → Voice transcription**, select the detected
adapter (the default installer path appears as the compatibility location),
choose the routing mode, review upload consent and save. The standard discovery
location is `~/.tarobot/integrations/tingwu-asr`; it can be selected with the
installer's `--dir` option. Saving managed settings takes precedence over
legacy environment variables, including when the saved mode is All local.
These managed changes apply to subsequent recordings without restarting Bots.
Headless hosts use `tarobot integrations voice status|set` with the same policy.

For hosts that have never saved managed voice settings, the legacy setup is:

Add the non-secret settings below to `~/.tarobot/integrations.env` (all Bots) or `<Hub-state>/bots/<bot-id>/bot.env` (one Bot). The private adapter location retains its historical name to preserve configured paths; it does not imply a Lark dependency:

```bash
TINGWU_ASR_DIR="/absolute/path/to/.tarocub-secrets/tingwu_asr"
ASR_CLOUD_THRESHOLD_SECONDS="900"
ASR_CLOUD_JOB_RETENTION_DAYS="7"
```

Restart only the affected idle Bot from the App and test a real media file. Configuration checks do not verify cloud credentials; only a non-empty `transcription.txt` from a real smoke test proves the cloud route works. See [README.zh-CN.md](README.zh-CN.md) for the full Chinese workflow.

## App routing modes

Settings → Voice transcription offers all local, all cloud, or automatic by
duration. The automatic threshold is configurable from 1–120 minutes (15 by
default); audio at the threshold goes to the cloud. All-cloud includes short
and unknown-duration audio and reports failures without a local fallback.
All-local never uploads audio. Fixed modes are not overridden by caption routing
keywords. Switching modes preserves a valid automatic threshold and does not
restart an active transcription or the local service. Host policy takes precedence
over per-Bot environment settings.
