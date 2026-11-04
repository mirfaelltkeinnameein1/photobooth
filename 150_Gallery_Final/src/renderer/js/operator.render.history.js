(function operatorHistoryRenderBootstrap(global) {
  const { bindAsyncButtons } = global.OperatorDom;

  // Accepted history list + reapply/retry/delete actions.
  function createOperatorHistoryRenderer(ctx) {
    const { state, els, api, relToFileUrl } = ctx;

    async function renderHistory() {
      const data = await api("/api/history");
      const items = data.items || [];
      els.historyList.innerHTML = items
        .map((item) => {
          const g1 = item.accepted?.group1?.accepted_copy_path || "";
          const g2 = item.accepted?.group2?.accepted_copy_path || "";
          const base = state.snapshot.config.root_dir;
          const g1Rel = g1 ? g1.replace(base + "\\", "").replace(/\\/g, "/") : "";
          const g2Rel = g2 ? g2.replace(base + "\\", "").replace(/\\/g, "/") : "";
          const g1Preview = g1Rel
            ? `<div class="aspect-square w-full overflow-hidden rounded border border-slate-700"><img src="${relToFileUrl(g1Rel)}" class="h-full w-full object-cover" /></div>`
            : `<div class="aspect-square w-full rounded border border-slate-700 bg-slate-900 p-2 text-[11px] text-slate-500">No G1 image</div>`;
          const g2Preview = g2Rel
            ? `<div class="aspect-square w-full overflow-hidden rounded border border-slate-700"><img src="${relToFileUrl(g2Rel)}" class="h-full w-full object-cover" /></div>`
            : `<div class="aspect-square w-full rounded border border-slate-700 bg-slate-900 p-2 text-[11px] text-slate-500">No G2 image</div>`;
          return `<div class="rounded border border-slate-700 bg-slate-800 p-2 text-xs">
            <div class="font-semibold">${item.uuid}</div>
            <div class="text-slate-400">${item.state}</div>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <div>
                ${g1Preview}
                <button class="btn-ghost mt-2 w-full history-reapply" data-uuid="${item.uuid}" data-group="group1">Reapply Group 1 original</button>
              </div>
              <div>
                ${g2Preview}
                <button class="btn-ghost mt-2 w-full history-reapply" data-uuid="${item.uuid}" data-group="group2">Reapply Group 2 original</button>
              </div>
            </div>
            <div class="mt-3 flex gap-2">
              <button class="btn-ghost w-full history-retry-export" data-uuid="${item.uuid}">Retry Export</button>
              <button class="btn-primary w-full history-delete" data-uuid="${item.uuid}">Delete History Entry</button>
            </div>
          </div>`;
        })
        .join("");

      bindAsyncButtons(els.historyList, ".history-reapply", (btn) =>
        api(`/api/history/${btn.dataset.uuid}/reapply`, "POST", { gallery: btn.dataset.group })
      );
      bindAsyncButtons(els.historyList, ".history-retry-export", (btn) =>
        api(`/api/jobs/${btn.dataset.uuid}/retry-export`, "POST", {})
      );
      bindAsyncButtons(els.historyList, ".history-delete", async (btn) => {
        if (!confirm(`Delete accepted history entry ${btn.dataset.uuid} and outgoing export files?`)) return;
        await api(`/api/history/${btn.dataset.uuid}`, "DELETE", { remove_outgoing: true });
      });
    }

    return { renderHistory };
  }

  global.createOperatorHistoryRenderer = createOperatorHistoryRenderer;
})(window);
