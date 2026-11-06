(function () {
  var CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  var MAX_PIXELS = 16e6;

  function loadScript(src) {
    return new Promise(function (ok, ko) {
      var s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = ko;
      document.head.appendChild(s);
    });
  }

  function init(root) {
    var url = root.dataset.pdf;
    var stage = root.querySelector(".poster-stage");
    var pagesEl = root.querySelector(".pages");
    var empty = root.querySelector(".empty-poster");
    var out = root.querySelector("output");
    var foot = root.querySelector("[data-foot]");
    var btn = {};
    root.querySelectorAll("[data-act]").forEach(function (b) { btn[b.dataset.act] = b; });
    var zoom = 1, pdf = null, token = 0;

    function setReady(r) {
      ["out", "in", "fit"].forEach(function (k) { if (btn[k]) btn[k].disabled = !r; });
      if (btn.out) btn.out.disabled = !r || zoom <= 0.5;
      if (btn.in) btn.in.disabled = !r || zoom >= 3;
      out.textContent = Math.round(zoom * 100) + "%";
    }

    function baseWidth() {
      return Math.min(Math.max(200, stage.clientWidth - 48), 1100);
    }

    async function render() {
      if (!pdf) return;
      var my = ++token, w = baseWidth() * zoom;
      var frag = document.createDocumentFragment();
      for (var n = 1; n <= pdf.numPages; n++) {
        var page = await pdf.getPage(n);
        if (my !== token) return;
        var v1 = page.getViewport({ scale: 1 });
        var scale = w / v1.width;
        var vp = page.getViewport({ scale: scale });
        var out = Math.min(window.devicePixelRatio || 1, 2);
        out = Math.min(out, Math.sqrt(MAX_PIXELS / (vp.width * vp.height)));
        var c = document.createElement("canvas");
        c.width = Math.floor(vp.width * out); c.height = Math.floor(vp.height * out);
        c.style.width = Math.floor(vp.width) + "px"; c.style.height = Math.floor(vp.height) + "px";
        await page.render({
          canvasContext: c.getContext("2d"),
          viewport: vp,
          transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null
        }).promise;
        if (my !== token) return;
        frag.appendChild(c);
      }
      pagesEl.replaceChildren(frag);
    }

    function fail() {
      empty.style.display = "flex";
      empty.querySelector("p").textContent = "The preview could not be loaded. You can still download the PDF.";
      setReady(false);
    }

    function change(z) {
      zoom = Math.min(3, Math.max(0.5, z));
      setReady(true);
      render();
    }
    if (btn.out) btn.out.onclick = function () { change(zoom - 0.25); };
    if (btn.in) btn.in.onclick = function () { change(zoom + 0.25); };
    if (btn.fit) btn.fit.onclick = function () { change(1); };

    var t;
    window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(render, 200); });

    setReady(false);
    loadScript(CDN + "pdf.min.js").then(function () {
      var lib = window.pdfjsLib;
      var blob = new Blob(['importScripts("' + CDN + 'pdf.worker.min.js");'], { type: "text/javascript" });
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      return lib.getDocument(url).promise;
    }).then(function (doc) {
      pdf = doc;
      empty.style.display = "none";
      stage.setAttribute("aria-busy", "false");
      if (foot) foot.textContent = "Use + and − to explore the details";
      setReady(true);
      return render();
    }).catch(fail);
  }

  document.querySelectorAll(".viewer[data-pdf]").forEach(init);
})();
