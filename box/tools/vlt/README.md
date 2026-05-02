# vlt

Local-first password manager TUI. Black/white with a yellow accent.

```bash
make release    # target/release/vlt
make install    # ~/.cargo/bin/vlt
vlt             # launch (real terminal required)
```

## Storage

- Vault: `$XDG_DATA_HOME/vlt/vault.json` — Argon2id + ChaCha20-Poly1305, atomic writes. Override with `VLT_VAULT_PATH`.
- Session cache: `$XDG_CACHE_HOME/vlt/session.json` — encrypted with a per-machine wrap key in the OS keyring (Keychain / Secret Service / Cred Manager). Default TTL 1h, override with `VLT_SESSION_TTL_SECONDS`.

## Keymaps

| screen | keys |
|--------|------|
| list | `↵` open · `n` new · `e` edit · `d` delete · `c`/`y` copy pw/user · `:` search · `←`/`→` collapse/expand · `L` lock · `?` help · `q` quit |
| detail | `r` reveal · `c`/`y`/`u` copy pw/user/url · `gx` open url · `1..9` copy link N · `g1..g9` open link N · `e` edit · `d` delete · `q` back |
| form | `Tab`/`↓↑` navigate · `Ctrl+S` save · `Ctrl+N` add link · `Ctrl+X` delete focused link · `Ctrl+G` generate · `Ctrl+R` reveal · `Esc` cancel |
| generator | `+/-` length · `s` symbols · `n` numbers · `g`/`↵` regen · `c`/`y` copy · `q` back |

## License

MIT
