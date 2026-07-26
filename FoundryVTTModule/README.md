# D&D Search for Foundry VTT

A Foundry VTT module that will provide Dungeons & Dragons search and reference tools.

## Development

Run `npm run build` to compile TypeScript into `dist/`. Place or link this project in Foundry's `Data/modules/dndsearch` directory, then enable **D&D Search** in a test world.

The empty `assets`, `templates`, and `packs` directories are reserved for module artwork, UI templates, and compendium content.

## Release

`module.json` contains placeholders for the release version, manifest URL, and download URL. `npm run package` reads the version from `package.json`, resolves those values into `release/module.json`, and includes that generated manifest in `release/dndsearch-mcp-module.zip`. Publish both release files as GitHub release assets.
