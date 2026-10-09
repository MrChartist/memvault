# Third-party licences

MemVault itself is under the MIT licence (see [LICENSE](LICENSE)). It includes, or installs, the following.

## Fonts that ship inside this package

The dashboard uses two fonts, served from this package (never from another website).

| Font | Licence | Licence text |
|---|---|---|
| Plus Jakarta Sans, © 2020 The Plus Jakarta Sans Project Authors (https://github.com/tokotype/PlusJakartaSans) | SIL Open Font License 1.1 | [public/brand/fonts/OFL-PlusJakartaSans.txt](public/brand/fonts/OFL-PlusJakartaSans.txt) |
| Inter, © 2016 The Inter Project Authors (https://github.com/rsms/inter) | SIL Open Font License 1.1 | [public/brand/fonts/OFL-Inter.txt](public/brand/fonts/OFL-Inter.txt) |

The font files in `public/brand/fonts/` are subsets (Latin and Latin Extended) in WOFF2 format. Each licence text is kept next to the files, as the licence asks.

## Brand files

The Mr. Chartist logo files in `public/brand/` are **not** under the MIT licence. See [TRADEMARKS.md](TRADEMARKS.md).

## Software installed with MemVault

`npm install` adds 101 packages. They are not copied into this repository; each one keeps its own licence inside `node_modules`. At the time of this review (checked by reading each installed package's `package.json`):

| Licence | Packages |
|---|---|
| MIT | 91 |
| ISC | 7 |
| BSD-3-Clause | 2 (`qs`, `fast-uri`) |
| BSD-2-Clause | 1 (`json-schema-typed`) |

The five direct dependencies are `@modelcontextprotocol/sdk`, `express`, `multer`, `sql.js` and `zod`. All are MIT. No package in the installed tree uses a copyleft licence. Re-check this before each release; a script that lists every licence is in `docs/review/REVIEW.md`.
