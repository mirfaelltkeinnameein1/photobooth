(function operatorDomBootstrap(global) {
  // Small DOM helper wrapper for async buttons.
  function bindAsyncButtons(root, selector, handler) {
    if (!root) return;
    root.querySelectorAll(selector).forEach((btn) => {
      btn.onclick = async (ev) => {
        try {
          await handler(btn, ev);
        } catch (err) {
          alert(err.message);
        }
      };
    });
  }

  global.OperatorDom = {
    bindAsyncButtons
  };
})(window);
