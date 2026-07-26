const MODULE_ID = "dndsearch";

Hooks.once("init", () => {
  if (!(game instanceof foundry.Game)) return;

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
  if (!(game instanceof foundry.Game)) return;
  if (!ui.notifications) return;
  
  if (game.settings.get(MODULE_ID, "showWelcomeMessage") ) {
    ui.notifications.info("D&D Search is ready.");

    const activeGMs = game.users?.filter(x => x.isActiveGM) ?? []; 
    // Note: not entirely clear who this is when multiple GM users join the game
    const activeGMNames = activeGMs.map(x => x.name).join(", ");
    ui.notifications.info(`[D&D Search] Active Game Masters: ${activeGMNames}`);
  }
});
