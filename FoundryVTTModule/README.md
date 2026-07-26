# D&D Search for Foundry VTT

A Foundry VTT module that will provide Dungeons & Dragons search and reference tools.

## Development

Run `npm run build` to compile TypeScript into `dist/`. Place or link this project in Foundry's `Data/modules/dndsearch` directory, then enable **D&D Search** in a test world.

The empty `assets`, `templates`, and `packs` directories are reserved for module artwork, UI templates, and compendium content.

## Release

Before publishing, update the version and compatibility values in `module.json`, build the project, and package the module files (including `dist/`) in a ZIP archive. Add public `manifest` and `download` URLs to `module.json` once releases are hosted.
