(function operatorSlotsRenderBootstrap(global) {
  // Live 12-slot preview + slot registry controls.
  function createOperatorSlotsRenderer(ctx) {
    const { state, els, api, relToFileUrl } = ctx;

    function renderSlotGrid() {
      const allSlots = (state.snapshot.slots || []).slice();
      const filter = els.slotFilter?.value || "all";
      const slots = allSlots.filter((s) => {
        if (filter === "active") return !!s.active;
        if (filter === "inactive") return !s.active;
        return true;
      });

      const groupStatus = state.snapshot?.config?.group_status;
      if (els.groupStatus) {
        if (groupStatus?.valid) {
          els.groupStatus.textContent = `Group split valid: group1=${groupStatus.counts.group1}, group2=${groupStatus.counts.group2}`;
          els.groupStatus.className = "mb-2 text-xs text-emerald-300";
        } else {
          els.groupStatus.textContent = `Group split invalid: ${groupStatus?.reason || "Set equal non-zero active counts for group1/group2"}`;
          els.groupStatus.className = "mb-2 text-xs text-amber-300";
        }
      }

      const sig = slots
        .map((s) => `${filter}|${s.slot}|${s.active}|${s.display_gallery}|${s.generation_group}|${s.background_mtime_ms || 0}`)
        .join(";");

      if (sig === state.slotGridSignature) {
        // Skip full DOM rebuild if nothing meaningful changed.
        return;
      }
      state.slotGridSignature = sig;

      const cards = [];
      slots.forEach((slotObj) => {
        const bgUrl = relToFileUrl(slotObj.background_rel, slotObj.background_mtime_ms || 0);
        const activeBadge = slotObj.active ? "text-emerald-300" : "text-slate-400";

        cards.push(`
          <div class="rounded-lg border border-slate-700 bg-slate-800 p-2">
            <div class="mb-2 flex items-center justify-between gap-2 text-xs">
              <span class="font-semibold">${slotObj.slot}</span>
              <span class="${activeBadge}">${slotObj.active ? "ACTIVE" : "INACTIVE"}</span>
            </div>
            <div class="relative aspect-square w-full overflow-hidden rounded border border-slate-700">
              <img src="${bgUrl}" class="absolute inset-0 h-full w-full object-cover" />
            </div>
            <div class="mt-2 flex items-center justify-between gap-2 text-xs">
              <label class="text-slate-300">Active</label>
              <input type="checkbox" class="h-4 w-4 slot-active" data-slot="${slotObj.slot}" ${slotObj.active ? "checked" : ""} />
            </div>
            <div class="mt-2 text-[11px] text-slate-400">Gallery</div>
            <select class="inp mt-1 slot-gallery" data-slot="${slotObj.slot}">
              <option value="gallery1" ${slotObj.display_gallery === "gallery1" ? "selected" : ""}>gallery1</option>
              <option value="gallery2" ${slotObj.display_gallery === "gallery2" ? "selected" : ""}>gallery2</option>
            </select>
            <div class="mt-2 text-[11px] text-slate-400">Generation group</div>
            <select class="inp mt-1 slot-group" data-slot="${slotObj.slot}">
              <option value="group1" ${slotObj.generation_group === "group1" ? "selected" : ""}>group1</option>
              <option value="group2" ${slotObj.generation_group === "group2" ? "selected" : ""}>group2</option>
            </select>
            <button class="btn-ghost mt-2 w-full revert-btn" data-slot="${slotObj.slot}">Revert to Default</button>
          </div>`);
      });

      els.slotGrid.innerHTML = cards.join("");
      els.slotGrid.querySelectorAll(".slot-active").forEach((input) => {
        input.onchange = async () => {
          try {
            await api(`/api/slots/${input.dataset.slot}/config`, "POST", {
              active: !!input.checked
            });
          } catch (err) {
            alert(err.message);
          }
        };
      });
      els.slotGrid.querySelectorAll(".slot-gallery").forEach((select) => {
        select.onchange = async () => {
          try {
            await api(`/api/slots/${select.dataset.slot}/config`, "POST", {
              display_gallery: select.value
            });
          } catch (err) {
            alert(err.message);
          }
        };
      });
      els.slotGrid.querySelectorAll(".slot-group").forEach((select) => {
        select.onchange = async () => {
          try {
            await api(`/api/slots/${select.dataset.slot}/config`, "POST", {
              generation_group: select.value
            });
          } catch (err) {
            alert(err.message);
          }
        };
      });
      els.slotGrid.querySelectorAll(".revert-btn").forEach((btn) => {
        btn.onclick = async () => {
          try { await api(`/api/slots/${btn.dataset.slot}/revert`, "POST", {}); }
          catch (err) { alert(err.message); }
        };
      });
    }

    return { renderSlotGrid };
  }

  global.createOperatorSlotsRenderer = createOperatorSlotsRenderer;
})(window);
