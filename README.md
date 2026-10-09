# automation

Everything is in [`flowforge/`](flowforge/) - see [flowforge/README.md](flowforge/README.md).

| Path                 | What                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `flowforge/`         | The FlowForge project: server, editor, Windows / Android / iPhone apps, website |
| `.github/workflows/` | Builds and releases (GitHub only reads workflows from here)                     |
| `vercel.json`        | Vercel deploy: import this repository and press Deploy, no settings needed      |

```bash
cd flowforge
pnpm install
pnpm dev
```
