# The MemVault web page

`site/` is the product page for MemVault: one `index.html` (the page and its styles) and an `assets/` folder (the official Mr. Chartist logo, the fonts, screenshots and the share image). It has no build step, uses no cookies, and loads nothing from other websites. The same folder works on MrChartist.com and on GitHub Pages.

## Put it on MrChartist.com (Hostinger)

1. In hPanel, open **Files → File Manager** and go to `public_html`.
2. Create a folder named `memvault`.
3. Upload **everything inside** `site/` into it: `index.html` and the whole `assets` folder, keeping the folder structure.
4. Open `https://mrchartist.com/memvault/` and check that the page appears (not the home page).

*Needs verification after the first upload:* MrChartist.com is a single-page app. Hostinger normally serves a real folder before the app's catch-all rule. If the home page appears instead, check the site's `.htaccess`: the rewrite rule must skip existing files and folders (`RewriteCond %{REQUEST_FILENAME} !-f` and `!-d`).

To link to it from the main site, use `/memvault/`.

## Publish it on GitHub Pages too

One-time setup by the repository owner: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

After that, `.github/workflows/pages.yml` publishes `site/` to `https://mrchartist.github.io/memvault/` whenever `site/` changes on `main`. You can also run it by hand from the **Actions** tab. Until Pages is switched on, that workflow fails with "Get Pages site failed".

## Vercel

The repository is also connected to a Vercel project. `vercel.json` tells Vercel to publish `site/` (the product page). Without it, Vercel's default for a project like this is `public/`, which is the dashboard: that only works with MemVault running on your own computer, so online it could only ask for a key. Every pull request gets a preview, and the `main` branch is the live address. Vercel's own settings (the domain, who can see previews) are in your Vercel account.

## Choose one main address

When the page is on both addresses, tell search engines which one is the main one. Add these two lines inside `<head>` in `site/index.html` (shown here for MrChartist.com):

```html
<link rel="canonical" href="https://mrchartist.com/memvault/">
<meta property="og:url" content="https://mrchartist.com/memvault/">
```

The share image (`og:image`) is a full address on GitHub Pages, so link previews work wherever the page is hosted, once Pages is on. If you do not use GitHub Pages, change it to `https://mrchartist.com/memvault/assets/img/og.png`.

## When MemVault is on npm

The install box says "Works today: install from the source code", plus a short "Coming soon" note about npm. After the first release is published (see [release.md](release.md)):

1. In `site/index.html`, find the comment `NPM-RELEASE`.
2. Change the commands to:
   ```
   npm install -g @mrchartist/memvault
   memvault setup
   memvault mcp-config
   memvault open
   ```
3. Remove the "Coming soon" box.
4. Make the same change in the README.

## Keep it true

- **Screenshots:** `npm run screenshots` takes them again from a throwaway vault, for the README (`docs/images`) and for the page (`site/assets/img`), along with the share image. Run it after changing the dashboard.
- **Automatic checks:** `tests/site.test.js` runs with `npm test`. It checks that:
  - every file the page uses is in the folder;
  - nothing is loaded from other websites;
  - every in-page link has a target;
  - every image has a description or is marked as decoration;
  - the logo and fonts are the official files, unchanged;
  - the screenshots are the same as the README's;
  - the version and the Node.js requirement match `package.json`.
- **Claims:** the page repeats claims from the README and SECURITY.md. When one of those changes, change the page too.
