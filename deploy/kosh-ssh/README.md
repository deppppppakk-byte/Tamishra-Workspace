# Kosh SSH deployment

Kosh uses OpenSSH as the standard SSH protocol boundary and keeps authorization
inside Kosh.

## Runtime identities

Create two operating-system accounts:

- `git` — owns no login shell and is the only SSH target account.
- `kosh-ssh-auth` — runs the AuthorizedKeysCommand helper. It needs network
  access to the Kosh Gateway only.

The `git` account needs read/write access to `KOSH_REPO_ROOT`. The
`kosh-ssh-auth` account must not have access to repository storage.

## Install helpers

Build:

```bash
npm run build:kosh-ssh
```

Install or symlink the executables:

```bash
/usr/local/bin/kosh-ssh-authorized-keys -> <workspace>/apps/kosh-ssh/dist/authorized-keys.js
/usr/local/bin/kosh-ssh-shell           -> <workspace>/apps/kosh-ssh/dist/shell.js
```

Both files require Node.js 22.

## Environment

The AuthorizedKeysCommand and forced shell require:

```env
KOSH_GATEWAY_ORIGIN=https://kosh.tamishra.in
KOSH_SSH_SERVICE_TOKEN=<shared-long-random-secret>
KOSH_SSH_SHELL_COMMAND=/usr/local/bin/kosh-ssh-shell
KOSH_REPO_ROOT=/var/lib/kosh/repos
```

The same `KOSH_SSH_SERVICE_TOKEN` must be configured on the Gateway.

## Security boundary

Kosh SSH never starts a user shell.

Only these client commands are accepted:

- `git-upload-pack 'namespace/repository.git'`
- `git-receive-pack 'namespace/repository.git'`

The repository operation is authorized by the same Kosh Access engine used by
HTTP, Pages, Mesh and Pulse.

OpenSSH disables:

- password login
- PTY allocation
- port forwarding
- agent forwarding
- X11 forwarding
- user rc files
- tunnels

Use a dedicated host key and keep administrator SSH on a different host or
port.

## Clone

```bash
git clone git@kosh.tamishra.in:tamishra/project.git
```

For a non-default public SSH port:

```bash
git clone ssh://git@kosh.tamishra.in:2222/tamishra/project.git
```
