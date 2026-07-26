# Agent instructions for the Foundry VTT module

## Design reference

Follow the design principles and conventions from the [League of Foundry Developers FoundryVTT Module Template](https://github.com/League-of-Foundry-Developers/FoundryVTT-Module-Template/tree/master) when designing or changing this module. Treat the upstream template as the source of truth when these instructions are not specific enough; check its current documentation and examples before introducing a new project structure or integration pattern.

Also consult Foundry VTT's [package manifest+ specifications](https://foundryvtt.wiki/en/development/manifest-plus) when creating or modifying package manifests, metadata, or related module packaging configuration. Follow the current specification for supported fields and their expected structure.

## Module-specific expectations

- Keep the module self-contained under this directory and preserve the template's conventional Foundry module layout (`src`, `dist`, `styles`, `templates`, `lang`, `assets`, and `packs`).
- Prefer small, focused TypeScript modules and Foundry APIs over custom global state or unrelated framework abstractions.
- Keep user-facing text localizable through `lang/en.json`; do not hard-code interface text in TypeScript or templates when it may need translation.
- Use the Foundry VTT type definitions already installed by this project and keep the target Foundry version in `module.json`, `package.json`, and the implementation consistent.
- Keep source files in `src/`; treat `dist/` as build output and regenerate it with `npm run build` rather than hand-editing generated files.
- Follow existing conventions for module metadata, lifecycle hooks, styles, packaging, and release files before adding new conventions.
- Check compatibility, build output, and packaging implications for every module change. Update the README or changelog when user-visible behavior or release metadata changes.

When an upstream template convention cannot be followed because of a D&D Search requirement, document the reason in the change and keep the deviation as small as possible.
