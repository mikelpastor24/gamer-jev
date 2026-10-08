const query = (selector) => document.querySelector(selector);

export function createRomLibrary({ request, onLoad, message }) {
  const select = query("#rom-choice");
  const load = query("#load-rom");
  const summary = query("#rom-library-summary");
  let refreshing = false;
  let loading = false;
  let enabled = false;

  async function refresh() {
    if (refreshing || loading) return;
    refreshing = true; select.disabled = true; load.disabled = true;
    const selected = select.value;
    try {
      const result = await request("/api/roms");
      enabled = result.enabled;
      select.replaceChildren();
      if (!result.entries.length) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "No ROMs found"; select.append(option);
      }
      for (const entry of result.entries) {
        const option = document.createElement("option");
        option.value = entry.id; option.textContent = entry.name; option.title = entry.name;
        select.append(option);
      }
      if (result.entries.some((entry) => entry.id === selected)) select.value = selected;
      summary.textContent = !enabled ? "ROM loading is unavailable in this viewer." : result.entries.length ?
        `${result.entries.length} local ${result.entries.length === 1 ? "ROM" : "ROMs"} available. Reopen this tab to refresh the list.` :
        "Add your own .gb or .gbc files to roms/, then reopen this tab. Files must be at most 8 MiB.";
    } catch (error) { enabled = false; message(error.message, true); }
    finally { refreshing = false; select.disabled = !enabled || !select.value; load.disabled = select.disabled; }
  }
  query("#settings-dialog").addEventListener("settings-tab-change", (event) => { if (event.detail === "roms") void refresh(); });
  query("#open-settings").addEventListener("click", () => { if (!query("#settings-roms").hidden) void refresh(); });
  select.addEventListener("change", () => { select.title = select.selectedOptions[0]?.textContent ?? ""; });
  query("#rom-library-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || refreshing || !enabled || !select.value) return;
    loading = true; select.disabled = true; load.disabled = true; load.textContent = "Loading…";
    try {
      const status = await request("/api/rom", { id: select.value });
      onLoad(status);
      message("ROM loaded. Saved progress is restored automatically when available. Resume when ready.");
    } catch (error) { message(error.message, true); }
    finally { loading = false; select.disabled = !enabled || !select.value; load.disabled = select.disabled; load.textContent = "Load selected ROM"; }
  });
}
