# MinerU Node Field List and Display Validation Matrix

## Final Field List

1. `textSplitter`
2. `mode` (`fast` | `accurate`, default `fast`)
3. `inputMode` (`url` | `file`, default `file`)
4. `fileUrls` (shown when `inputMode=url`)
5. `fileUpload` (shown when `inputMode=file`)
6. `token` (shown when `mode=accurate`)
7. `accurateModel` (`auto` | `vlm` | `pipeline` | `html`, shown when `mode=accurate`)
8. `ocr` (shown when `mode=accurate`)
9. `formula` (shown when `mode=accurate`)
10. `table` (shown when `mode=accurate`)
11. `language` (default `ch`)
12. `pageRange` (optional, empty means all pages)
13. `splitPages` (optional advanced)
14. `timeoutSeconds` (default `300`)
15. `metadata` (optional advanced)

## Display and Validation Matrix

| Field            | Type         | Default                 | Show Condition   | Required             | Validation Rule                                    | API Mapping                                    |
| ---------------- | ------------ | ----------------------- | ---------------- | -------------------- | -------------------------------------------------- | ---------------------------------------------- |
| `mode`           | options      | `fast`                  | always           | yes                  | must be `fast` or `accurate`                       | routing only                                   |
| `inputMode`      | options      | `file`                  | always           | yes                  | must be `url` or `file`                            | routing only                                   |
| `fileUrls`       | string       | none                    | `inputMode=url`  | yes in URL mode      | split by newline/comma, at least one non-empty URL | `url` source                                   |
| `fileUpload`     | file         | none                    | `inputMode=file` | yes in file mode     | at least one uploaded file                         | file upload source                             |
| `token`          | password     | `MINERU_TOKEN` fallback | `mode=accurate`  | yes in accurate mode | non-empty after env fallback                       | `Authorization: Bearer <token>`                |
| `accurateModel`  | options      | `auto`                  | `mode=accurate`  | no                   | enum only                                          | `model_version`                                |
| `ocr`            | boolean      | `false`                 | `mode=accurate`  | no                   | boolean                                            | `is_ocr`                                       |
| `formula`        | boolean      | `true`                  | `mode=accurate`  | no                   | boolean                                            | `enable_formula` (false only when disabled)    |
| `table`          | boolean      | `true`                  | `mode=accurate`  | no                   | boolean                                            | `enable_table` (false only when disabled)      |
| `language`       | string       | `ch`                    | always           | no                   | trimmed string                                     | `language`                                     |
| `pageRange`      | string       | empty                   | always           | no                   | if provided must match page expression parser      | `page_range` (fast) / `page_ranges` (accurate) |
| `splitPages`     | boolean      | `false`                 | always           | no                   | if true and PDF, current node requires `pageRange` | internal task split only                       |
| `timeoutSeconds` | number       | `300`                   | always           | no                   | positive integer, fallback to `300`                | polling timeout                                |
| `metadata`       | json         | empty                   | always           | no                   | valid JSON object/string                           | output metadata merge                          |
| `textSplitter`   | TextSplitter | none                    | always           | no                   | valid Flowise splitter instance                    | post-processing                                |

## Behavior Notes

1. `pageRange` empty: node does not send page range field, so MinerU processes all pages by default.
2. `splitPages=true`: this node currently requires `pageRange` for deterministic per-page tasks.
3. Default UX after drag-and-drop:
    - `mode=fast`
    - accurate-only fields remain hidden until user switches to `accurate`.
4. Recommended inline help placement:
    - `mode` description includes API docs link.
    - `token` description includes token apply link and API docs link.
