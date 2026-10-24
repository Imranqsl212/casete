# Repo Cassette CTF helper

This repository builds GitHub Actions artifacts for the Repo Cassette challenge. The workflow creates self-referential JSON artifact bodies and races artifact MIME metadata so the archive service and postcard service interpret the MIME value differently.

## Build artifacts

Push these files to the `main` branch, or run **Build Repo Cassette artifacts** from the Actions tab. Wait for the workflow to finish before trying the instance. Each run creates a batch of artifacts named `repo-cassette-race-*`.

## Solve

Use a GitHub CLI session that can read this repository's Actions artifacts, then run:

```bash
python3 solve.py http://repo-archive.chal.hitconctf.com:PORT Imranqsl212/casete
```

The solver imports candidate artifacts into the challenge, checks which one passes source verification, requests the postcard, and extracts the flag from its embedded portrait data.

The challenge instance expires after five minutes. Build the artifacts first, then launch or renew the instance immediately before running the solver.
