"use strict";
const MODULE_ID = "dndsearch";
Hooks.once("init", () => {
    if (!(game instanceof foundry.Game))
        return;
    game.settings.register(MODULE_ID, "showWelcomeMessage", {
        name: "DNDSEARCH.Settings.ShowWelcomeMessage.Name",
        hint: "DNDSEARCH.Settings.ShowWelcomeMessage.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true
    });
});
Hooks.once("ready", () => {
    if (!(game instanceof foundry.Game))
        return;
    if (!ui.notifications)
        return;
    if (game.settings.get(MODULE_ID, "showWelcomeMessage")) {
        ui.notifications.info("D&D Search is ready.");
    }
});
//# sourceMappingURL=module.js.map