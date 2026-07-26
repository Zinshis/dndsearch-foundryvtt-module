import * as configuration from "@league-of-foundry-developers/foundry-vtt-types/src/configuration/configuration.d.mts";

export {};

declare global {
  interface SettingConfig extends configuration.SettingConfig {
    "dndsearch.showWelcomeMessage": boolean;
  }
}
