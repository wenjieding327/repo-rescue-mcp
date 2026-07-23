# Evidence levels

Use the narrowest level supported by actual evidence.

| Level | Claim | Required evidence |
|---|---|---|
| S1 | Snippet executed | Supplied snippet ran in the constrained runtime |
| S2 | Snippet fix verified | Original failed a stated case and repaired code passed the same case |
| F1 | File validated | Target file compiled or its focused tests passed |
| P1 | Repository inspected | Repository and commit were retrieved; no execution claim |
| P2 | Dependencies resolved | Declared dependencies were installed or resolved successfully |
| P3 | Tests executed | Named test scope ran with recorded command and exit code |
| P4 | Official demo reproduced | The documented official example ran with expected observable output |
| P5 | Paper metric reproduced | The stated dataset, configuration, seed policy, hardware boundary, and metric were compared with the paper |

Always include the tested scope. “102 tests passed” is P3 only when the exact suite or selection is named. A smoke test is not the full upstream suite. P3 does not imply P4 or P5.

Use `partial` when only some requirements are met. Prefer “P3 core tests passed” over a boolean `verified: true` in user-facing text.
