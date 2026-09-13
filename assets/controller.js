/* Scrybert Controller — console logic.
 *
 * No framework, no build step, no inline script: the vhost ships a CSP with script-src
 * 'self', so everything lives in this file and nothing is evaluated from a string.
 *
 * Auth is the session cookie the API sets. The API key is never used here and is only
 * fetched on an explicit click.
 */
(function () {
  "use strict";

  var API = "/v1/controller";

  // Display order = the order these actually reach a model. Pivotal Moments is nested
  // under the summarizer because it runs on the summarizer's finished output, but it is
  // its own prompt and its own call.
  var ORDER = ["summarizer", "pivotal_moments", "regenerater", "todo_sweep", "parse_event"];
  var NESTED = { pivotal_moments: true };
  var SUBTITLE = {
    summarizer: "Call 1 — the first pass over a transcript",
    pivotal_moments: "Call 2 — runs on the finished summary. Skipped on regenerate.",
    regenerater: "Call 1 — a rewrite. No moments, no lister, to-dos forced off.",
    todo_sweep: "Call 3 — picks one action item to become a reminder",
    parse_event: "Call 4 — one dictated sentence into a calendar event"
  };

  var state = { user: null, cores: [], coreId: null, core: null, timers: {} };

  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove("ctl-hidden"); }
  function hide(el) { el.classList.add("ctl-hidden"); }

  function api(path, method, body) {
    return fetch(API + path, {
      method: method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { throw { status: r.status, data: data }; }
        return data;
      });
    });
  }

  // ---------------------------------------------------------------- sign in

  function loginError(msg) {
    var box = $("login-error");
    if (!msg) { hide(box); return; }
    box.textContent = msg;
    show(box);
  }

  function onLogin(ev) {
    ev.preventDefault();
    loginError("");
    var email = $("input-email").value.trim();
    var newPw = $("input-new-password");
    var settingPassword = !$("row-new-password").classList.contains("ctl-hidden");

    if (settingPassword) {
      if (newPw.value.length < 10) { loginError("At least 10 characters."); return; }
      api("/set_password", "POST", { email: email, new_password: newPw.value })
        .then(enterConsole)
        .catch(function (e) { loginError(detail(e) || "Could not set that password."); });
      return;
    }

    api("/login", "POST", { email: email, password: $("input-password").value })
      .then(function (data) {
        if (data.needs_password) {
          // First login. Access came from the account's role; no password was emailed.
          hide($("row-password"));
          show($("row-new-password"));
          $("btn-login").textContent = "Set password and sign in";
          $("input-new-password").focus();
          return;
        }
        enterConsole(data);
      })
      .catch(function (e) { loginError(detail(e) || "Wrong email or password."); });
  }

  function detail(e) {
    var d = e && e.data && e.data.detail;
    if (typeof d === "string") { return d; }
    if (d && d.error) { return d.error; }
    return null;
  }

  function enterConsole(data) {
    state.user = data.user;
    hide($("screen-login"));
    show($("screen-console"));
    $("label-email").textContent = data.user.email;
    $("badge-role").textContent = data.user.role.replace("_", " ");
    // An Admin may edit and save; only a Super Admin may put something Live.
    if (data.user.role !== "super_admin") {
      $("btn-promote").disabled = true;
      $("btn-promote").title = "Only a Super Admin can promote to Live";
    }
    loadCores();
  }

  // ---------------------------------------------------------------- cores

  function loadCores() {
    api("/cores").then(function (data) {
      state.cores = data.cores;
      renderRail();
      if (!state.coreId && data.cores.length) { selectCore("summarizer"); }
    });
  }

  function renderRail() {
    var list = $("list-cores");
    list.innerHTML = "";
    ORDER.forEach(function (id) {
      var core = state.cores.filter(function (c) { return c.core_id === id; })[0];
      if (!core) { return; }
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctl-core-item" + (NESTED[id] ? " is-nested" : "") +
                      (state.coreId === id ? " is-active" : "");
      btn.dataset.coreId = id;

      var dot = document.createElement("span");
      dot.className = "ctl-dot " +
        (core.published_version === core.latest_version ? "ctl-dot--live" : "ctl-dot--draft");

      var name = document.createElement("span");
      name.className = "ctl-core-item__name";
      name.textContent = core.name;
      var sub = document.createElement("span");
      sub.className = "ctl-core-item__sub";
      sub.textContent = "Live v" + core.published_version + " · latest v" + core.latest_version;
      name.appendChild(sub);

      btn.appendChild(dot);
      btn.appendChild(name);
      btn.addEventListener("click", function () { selectCore(id); });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function selectCore(id) {
    state.coreId = id;
    renderRail();
    api("/cores/" + id).then(function (core) {
      state.core = core;
      hide($("editor-empty"));
      show($("editor"));
      $("label-core-name").textContent = core.name;
      $("label-core-meta").textContent =
        (SUBTITLE[id] || "") + "  ·  factory default: " + core.source_file;
      renderProblems(core.problems);
      renderFields(core.fields);
      status("");
    });
  }

  function renderProblems(problems) {
    var box = $("banner-problems");
    if (!problems || !problems.length) { hide(box); return; }
    box.innerHTML = "<strong>Cannot promote:</strong><ul class=\"mb-0 mt-1\"></ul>";
    var ul = box.querySelector("ul");
    problems.forEach(function (p) {
      var li = document.createElement("li");
      li.textContent = p;
      ul.appendChild(li);
    });
    show(box);
  }

  function renderFields(fields) {
    var wrap = $("list-fields");
    wrap.innerHTML = "";
    fields.forEach(function (f) {
      var card = document.createElement("div");
      card.className = "ctl-field";
      card.id = "field-" + f.key;

      var head = document.createElement("div");
      head.className = "ctl-field__head";
      var nm = document.createElement("span");
      nm.className = "ctl-field__name";
      nm.textContent = f.name;
      var key = document.createElement("span");
      key.className = "ctl-field__key";
      key.textContent = f.key;
      head.appendChild(nm);
      head.appendChild(key);

      var ta = document.createElement("textarea");
      ta.className = "ctl-field__editor";
      ta.id = "editor-" + f.key;
      ta.value = f.body;
      ta.spellcheck = false;
      ta.rows = Math.min(24, Math.max(3, f.body.split("\n").length + 1));
      ta.addEventListener("input", function () { queueSave(f.key, ta, card); });

      card.appendChild(head);
      card.appendChild(ta);
      wrap.appendChild(card);
    });
  }

  // Autosave into the DRAFT only (version 0). Live traffic is untouched until Promote.
  function queueSave(key, ta, card) {
    card.classList.remove("is-saved");
    card.classList.add("is-saving");
    clearTimeout(state.timers[key]);
    state.timers[key] = setTimeout(function () {
      api("/cores/" + state.coreId + "/fields/" + key, "PUT", { body: ta.value })
        .then(function (res) {
          card.classList.remove("is-saving");
          card.classList.add("is-saved");
          renderProblems(res.problems);
        })
        .catch(function () {
          card.classList.remove("is-saving");
          status("Could not save that field.", "bad");
        });
    }, 600);
  }

  function status(msg, kind) {
    var el = $("banner-status");
    if (!msg) { hide(el); return; }
    el.textContent = msg;
    el.className = "ctl-status" + (kind ? " is-" + kind : "");
    show(el);
  }

  // ---------------------------------------------------------------- actions

  function doPreview() {
    api("/cores/" + state.coreId + "/preview").then(function (data) {
      $("text-preview").textContent = data.text;
      $("label-preview-bytes").textContent = data.bytes + " bytes";
      bootstrap.Modal.getOrCreateInstance($("modal-preview")).show();
    });
  }

  function doSaveVersion() {
    var note = $("input-save-note").value;
    api("/cores/" + state.coreId + "/save_version", "POST", { note: note })
      .then(function (res) {
        bootstrap.Modal.getOrCreateInstance($("modal-save")).hide();
        $("input-save-note").value = "";
        status("Saved as version " + res.version + ". Not Live until you promote it.", "ok");
        renderProblems(res.problems);
        loadCores();
      })
      .catch(function (e) { status(detail(e) || "Could not save.", "bad"); });
  }

  function doPromote() {
    api("/cores/" + state.coreId + "/promote", "POST", {})
      .then(function (res) {
        status("Live now — version " + res.published_version +
               ". Takes effect on the next summary, no restart.", "ok");
        loadCores();
      })
      .catch(function (e) {
        var problems = e && e.data && e.data.detail && e.data.detail.problems;
        if (problems) { renderProblems(problems); status("Not promoted — fix the problems above.", "bad"); }
        else { status(detail(e) || "Could not promote.", "bad"); }
      });
  }

  function doApiKey() {
    api("/api_key").then(function (data) {
      $("text-api-key").textContent = data.api_key || "—";
      bootstrap.Modal.getOrCreateInstance($("modal-api-key")).show();
    });
  }

  // ---------------------------------------------------------------- boot

  document.addEventListener("DOMContentLoaded", function () {
    $("form-login").addEventListener("submit", onLogin);
    $("btn-preview").addEventListener("click", doPreview);
    $("btn-save-version").addEventListener("click", function () {
      bootstrap.Modal.getOrCreateInstance($("modal-save")).show();
    });
    $("btn-save-confirm").addEventListener("click", doSaveVersion);
    $("btn-promote").addEventListener("click", doPromote);
    $("btn-api-key").addEventListener("click", doApiKey);
    $("btn-logout").addEventListener("click", function () {
      api("/logout", "POST", {}).then(function () { location.reload(); });
    });

    // Already signed in? Skip the login screen.
    api("/me").then(function (data) { enterConsole(data); }).catch(function () { /* show login */ });
  });
})();
