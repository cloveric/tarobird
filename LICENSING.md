# TaroBot licensing

Copyright (c) 2026 Cloveric.

Except for components carrying their own license or attribution, TaroBot is
licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). The complete, unmodified license text is in [LICENSE](LICENSE).
This applies to the shared host, CLI, desktop/mobile client, optional adapter
code and other project-owned material in this repository.

TaroBot is distributed without any warranty; see sections 15 and 16 of LICENSE.
The SPDX identifier explicitly selects version 3, rather than granting an
automatic option to use a later version.

## Separately licensed components

Their existing copyright, license and attribution notices remain in force.
The project license does not replace those component notices.

| Component / source location | Existing license or notice |
| --- | --- |
| `deepseek-harness-plugin/` | Independently published DeepSeek search plugin; MIT, as stated in its own `LICENSE` and package metadata |
| `client/src/assets/model-brands/`, also used in `assets/product/engines.png` | LobeHub model-brand icons; MIT and the existing trademark notice |
| `client/src/assets/fonts/sarasa-term-sc/` | Sarasa Term SC; its included font license |
| `assets/product/fonts/` | Bricolage Grotesque and Instrument Sans; their included OFL notices |
| `client/vendor/baoyu-{design,slides}/`, `skills/baoyu-{design,ppt}/` | baoyu-design: mixed licensing. Maintainer original work is MIT; reconstructed Anthropic editor, references and Anthropicons are excluded from that grant. See upstream LICENSE, NOTICE.md and editor/third-party-licenses.txt. Pinned source and file hashes: UPSTREAM.json. Build retains notices in client/dist/licenses/baoyu-*/ for both editors. Skill references retain the same upstream notices; they are not represented as MIT. |
| `client/public/licenses/` | Runtime notices for bundled libraries, fonts and icons |
| `skills/scrapling/SKILL.md` | Retains its attribution to the MIT-licensed upstream fetching reference |
| Gradle wrapper and other dependencies | Their own file headers, package licenses and notices |

The standalone CLI package includes this notice, the project LICENSE and the
independent DeepSeek plugin's MIT license. Its bundled web client retains the
runtime notices under `client/dist/licenses/`.

## Transition

The project license changes on 2026-10-18, after release 1.0.91 / CLI 0.1.439.
The change applies to this revision and subsequent project revisions unless
expressly stated otherwise. Earlier releases and source snapshots keep the
licenses supplied with them; their artifacts and Git tags are not rewritten.

The repository's privacy setting is separate from its license and is unchanged.

## 中文说明

TaroBot 主项目从本次修订起采用 **AGPL-3.0-only**（仅第 3 版）。完整条款以
[LICENSE](LICENSE) 为准。独立 DeepSeek 插件、第三方库、字体和图标保留各自的
许可与版权声明。本次变更不追溯修改此前已发布的安装包、源码快照及标签，
也不改变 GitHub 仓库的可见性。

References: [GNU license text](https://www.gnu.org/licenses/agpl-3.0.html) ·
[SPDX identifier](https://spdx.org/licenses/AGPL-3.0-only.html).
