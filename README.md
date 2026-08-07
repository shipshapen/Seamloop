<p align="center">
  <img alt="seamloop-icon" width="128px" src="extension/icons/icon-128.png">
</p>

<p align="center">
  <a rel="noreferrer noopener" href="PLACEHOLDER"><img alt="Chrome Web Store" src="https://img.shields.io/badge/Chrome-141e24.svg?&style=for-the-badge&logo=google-chrome&logoColor=white"></a>
  <a rel="noreferrer noopener" href="PLACEHOLDER"><img alt="Firefox Add-ons" src="https://img.shields.io/badge/Firefox-141e24.svg?&style=for-the-badge&logo=firefox-browser&logoColor=white"></a>
</p>

<h1 align="center">
  Seamloop
</h1>

<p align="center">
  Loop any soundtrack (OST) seamlessly on YouTube and YouTube Music.
</p>

<p>
  For music written to loop indefinitely, the default repeat functionality on YouTube is often abrupt and noticeable. Seamloop detects exactly where the music repeats and loops it smoothly for as long as you want.
</p>

<p align="center">
  <img alt="seamloop-screenshot" width="2560px" src="extension/screenshots/screenshot.png">
</p>

## Notes

- For proper usage, choose a video containing at least one repeat (whole or partial) of the music.
- If the loop is choppy, raising the "similarity threshold" typically yields a stronger match.
- When a loop cannot be found, lowering the "similarity threshold" increases the odds of finding it.
- Video scanning can be interrupted early for analysis once at least one repeat has been captured.
- Measures are in place to survive mid-roll ads. Ads may prolong scanning if "fast mode" is disabled.
- The length of scannable video is capped at the first 20 minutes due to memory use.
- Seamloop cannot download or export audio.

## Status

Compatible with Chrome ≥ 111 / Firefox ≥ 128. Safari impedes the necessary MediaSource hook injection.

For the specific thing I intended to do with Seamloop, I consider the current functionality sufficient.

If breakages are noticed, I'll look into repairs if feasible and whenever convenient.

Bug reports and forks are welcome!

## Privacy

Seamloop does not collect, store, or transmit any personal data.

It runs only on `youtube.com`/`music.youtube.com` and requests permission for `storage`.

## License

[MIT](LICENSE) © Shipshapen
