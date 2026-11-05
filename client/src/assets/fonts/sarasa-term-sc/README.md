# Sarasa Term SC

Upstream: https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43
Source: `SarasaTermSC-TTF-1.0.43.7z`, Regular and SemiBold.
License: SIL Open Font License 1.1, included in `LICENSE` and distributed
with the app as `/licenses/Sarasa-Term-SC.txt`.

These are complete fonts (51,251 mapped characters per face), converted to
WOFF2 without subsetting, outline editing or name changes. The complete upstream character coverage keeps supported simplified/traditional
Chinese and uncommon characters in the same terminal grid.
The two compressed files add approximately 16.7 MiB to the local assets.
CLI requests these faces for Chinese; legacy terminal-family themes also use
them. Native packages and the offline shell
include them so reading does not require a third-party font service.

Reproduce with FontTools 4.68.0 and Brotli 1.2.1:

```python
from fontTools.ttLib import TTFont
for weight in ("Regular", "SemiBold"):
    font = TTFont(f"SarasaTermSC-{weight}.ttf")
    font.flavor = "woff2"
    font.save(f"SarasaTermSC-{weight}.woff2")
```

SHA-256 receipts:

```json
{
  "Regular": {
    "source": "f23a56b66b8e4dfa9353113f3608bd215482fe2e3148309dac3753bfcacea665",
    "woff2": "112b341963594a3416fe329f97c71ef3123e55ad8cf4afbe2ef2699e3de48276",
    "bytes": 8661932,
    "characters": 51251,
    "oldCharactersRetained": true
  },
  "SemiBold": {
    "source": "2c9f63f917bf9cfdc9d2eb0a9ff947577d256c3ca96831f078b238695488cdd9",
    "woff2": "a51478dad4b869574d257bbba5f7ada6d6a17d8a3177f320f40c5dc9f94e87b4",
    "bytes": 8795188,
    "characters": 51251,
    "oldCharactersRetained": true
  }
}
```
