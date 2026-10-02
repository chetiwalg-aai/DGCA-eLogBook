## Video Guide

https://youtu.be/qVMiYGiWJ-E

## Browser Support

This extension works on both **Firefox** and **Chrome** (Manifest V3), but distribution differs between the two:

- **Chrome** — not published on the Chrome Web Store. Chrome users install it manually via **Load unpacked** (see below). This is a normal, safe way to run an extension you trust the source of — it just requires a couple of extra clicks since it isn't going through a storefront review.

## Install on Firefox

**Requirements:** Firefox 128 or later (Desktop)

1. Download the Firefox package from the Releases page and open the `.xpi` file.
2. Firefox will prompt to install — click **Add**.
3. The extension is signed by Mozilla, so no `about:config` changes or developer mode are required.
4. Firefox handles signed-extension updates automatically when new releases are published.

## Install on Chrome (Load Unpacked)

Since this isn't on the Chrome Web Store, you'll load the source folder directly. Chrome will keep it enabled permanently like any other extension — you won't receive storefront updates automatically, so you'll need to re-download and reload it manually for new versions.

1. Go to the [Releases page](https://github.com/chetiwalg-aai/DGCA-eLogBook/releases/latest) and download **`Source code (zip)`** (not the `.xpi` — that's Firefox-only and signed for Firefox specifically).
2. Unzip it anywhere on your computer.
3. Open Chrome and go to `chrome://extensions`.
4. Turn on **Developer mode** (toggle, top-right corner).
5. Click **Load unpacked**, then select the unzipped folder (the one containing `manifest.json`).
6. The extension icon should now appear in your toolbar. To update later, download the new release zip, replace the old folder, then click the ⟳ **Reload** icon on the extension's card in `chrome://extensions`.

> **Note:** Chrome may show a "Developer mode extensions" warning banner on browser startup — this is expected for any unpacked/sideloaded extension and doesn't indicate a problem with this one.
