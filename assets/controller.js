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
  // The two tips cores are app copy, not prompts: listed last, after every model call.
  var ORDER = ["summarizer", "pivotal_moments", "regenerater", "todo_sweep", "parse_event",
               "recapper", "home_tips", "convo_tips"];
  var NESTED = { pivotal_moments: true };
  var SUBTITLE = {
    summarizer: "Call 1 — the first pass over a transcript",
    pivotal_moments: "Call 2 — runs on the finished summary. Skipped on regenerate.",
    regenerater: "Call 1 — a rewrite. No moments, no lister, to-dos forced off.",
    todo_sweep: "Call 3 — picks one action item to become a reminder",
    parse_event: "Call 4 — one dictated sentence into a calendar event",
    recapper: "Its own pipeline — a day of titles, blurbs and to dos into two paragraphs. Runs on a clock, not on a conversation.",
    home_tips: "App copy, not a prompt. One tip per line, shown on Base one per load. End a line with [bunker_people], [bunker_things] or [bunker_location] to link it.",
    convo_tips: "App copy, not a prompt. One tip per line, shown on Convos one per load. End a line with [bunker_people], [bunker_things] or [bunker_location] to link it."
  };

  var state = { user: null, users: [], cores: [], coreId: null, core: null, timers: {},
               premades: [], premadeId: null, premade: null, taxonomy: null,
               premadeTimer: null,
               filter: { q: "", section: "", category: "" },
               sort: { key: "section", dir: 1 },
               editingUserId: null };

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
    // Unpublish and Delete sit behind the same gate server-side, so the buttons
    // are disabled here for the same reason - an Admin pressing them would only
    // ever collect a 403.
    if (data.user.role !== "super_admin") {
      ["btn-promote", "btn-premade-promote", "btn-premade-unpublish", "btn-premade-delete"]
        .forEach(function (id) {
          $(id).disabled = true;
          $(id).title = "Super Admin only";
        });
    }
    loadCores();
    loadTaxonomy().then(loadPremades).catch(function () {
      // A premades failure must not take the cores console down with it - the
      // instruction sets are the load-bearing half of this page.
      $("label-premade-count").textContent = "!";
      $("label-premade-count").title = "Premades failed to load";
    });
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
    state.premadeId = null;
    hide($("pane-premade"));
    hide($("pane-premades-browse"));
    show($("pane-editor"));
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

  // --------------------------------------------------------------- tree

  function toggleGroup(headId, bodyId) {
    var head = $(headId);
    var body = $(bodyId);
    var open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", open ? "false" : "true");
    if (open) { hide(body); } else { show(body); }
  }

  // ------------------------------------------------------------ premades
  //
  // Same draft -> save -> promote loop as the cores above. Two differences that
  // matter: a premade carries metadata (section, category, weight, author) that
  // is NOT versioned and saves immediately, and it can be unpublished or deleted
  // because it is distributed material rather than plumbing.

  function premadeStatus(msg, kind) {
    var box = $("banner-premade-status");
    if (!msg) { hide(box); return; }
    box.textContent = msg;
    box.className = "ctl-status " + (kind === "bad" ? "ctl-status--bad" : "ctl-status--ok");
    show(box);
  }

  function renderPremadeProblems(problems) {
    var box = $("banner-premade-problems");
    if (!problems || !problems.length) { hide(box); return; }
    box.innerHTML = "";
    problems.forEach(function (p) {
      var li = document.createElement("div");
      li.textContent = p;
      box.appendChild(li);
    });
    show(box);
  }

  function loadTaxonomy() {
    return api("/premades/categories").then(function (data) {
      state.taxonomy = data;
      [["select-premade-category", data.categories], ["select-new-category", data.categories]]
        .forEach(function (pair) {
          var sel = $(pair[0]);
          sel.innerHTML = "";
          var blank = document.createElement("option");
          blank.value = ""; blank.textContent = "—";
          sel.appendChild(blank);
          pair[1].forEach(function (c) {
            var o = document.createElement("option");
            o.value = c; o.textContent = c;
            sel.appendChild(o);
          });
        });
      var filterSel = $("select-filter-category");
      filterSel.innerHTML = "";
      var all = document.createElement("option");
      all.value = ""; all.textContent = "All categories";
      filterSel.appendChild(all);
      data.categories.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c; o.textContent = c;
        filterSel.appendChild(o);
      });
      renderChips();
      [["select-premade-section", data.sections], ["select-new-section", data.sections]]
        .forEach(function (pair) {
          var sel = $(pair[0]);
          sel.innerHTML = "";
          pair[1].forEach(function (sec) {
            var o = document.createElement("option");
            o.value = sec;
            o.textContent = (data.section_labels && data.section_labels[sec]) || sec;
            sel.appendChild(o);
          });
        });
    });
  }

  function loadPremades() {
    return api("/premades").then(function (data) {
      state.premades = data.premades || [];
      renderPremadeRail();
    });
  }

  function renderPremadeRail() {
    var live = state.premades.filter(function (p) { return p.live; }).length;
    $("label-premade-count").textContent = live + "/" + state.premades.length;
    $("label-premade-count").title = live + " live of " + state.premades.length + " total";
  }

  // ---------------------------------------------------------------- browse

  function sectionLabel(sec) {
    return (state.taxonomy && state.taxonomy.section_labels[sec]) || sec;
  }

  // ------------------------------------------------------------------ users
  //
  // The API key is shown ONCE, on create or rotate, and never lives in the table: the
  // server has no endpoint that returns it and public() omits it, so the moment it is
  // dismissed it is unrecoverable except by rotating. Treating it as ordinary row data
  // would imply otherwise.

  var ROLE_LABELS = { super_admin: "Super admin", admin: "Admin",
                      super_user: "Super user", user: "User" };

  // NOT state.user.can_promote. /me returns can_promote alongside `user`, not inside it,
  // and enterConsole keeps only data.user - so that property is undefined here. The rest
  // of this file already tests the role string; do the same and stay in step with it.
  function isSuperAdmin() {
    return !!(state.user && state.user.role === "super_admin");
  }

  // Mirrors the server's ceiling in console_edit_user(): a plain Admin may edit an
  // ordinary account but not an Admin's or a Super Admin's. Client-side check is only for
  // not offering a button that would 403 - the server enforces the real gate.
  function canEditUser(u) {
    if (isSuperAdmin()) { return true; }
    return u.role !== "super_admin" && u.role !== "admin";
  }

  function showUsers() {
    hide($("pane-editor"));
    hide($("pane-premade"));
    hide($("pane-premades-browse"));
    show($("pane-users"));
    hide($("form-new-user"));
    loadUsers();
  }

  function loadUsers() {
    return api("/users").then(function (data) {
      state.users = data.users || [];
      $("label-user-count").textContent = state.users.length;
      renderUsers();
    }).catch(function (e) {
      usersStatus((e.data && e.data.detail) || "Could not load users");
    });
  }

  function usersStatus(msg) {
    var box = $("banner-users-status");
    if (!msg) { hide(box); return; }
    box.textContent = msg;
    show(box);
  }

  function renderUsers() {
    var body = $("rows-users");
    body.innerHTML = "";
    var canRotate = isSuperAdmin();
    state.users.forEach(function (u) {
      var tr = document.createElement("tr");
      var editing = state.editingUserId === u.id;

      var idTd = document.createElement("td");
      idTd.textContent = String(u.id);
      tr.appendChild(idTd);

      var emailTd = document.createElement("td");
      var nameTd = document.createElement("td");
      if (editing) {
        var emailInput = document.createElement("input");
        emailInput.className = "form-control form-control-sm";
        emailInput.type = "email";
        emailInput.id = "edit-email-" + u.id;
        emailInput.value = u.email;
        emailTd.appendChild(emailInput);

        var nameWrap = document.createElement("div");
        nameWrap.className = "d-flex gap-1";
        var firstInput = document.createElement("input");
        firstInput.className = "form-control form-control-sm";
        firstInput.placeholder = "First";
        firstInput.id = "edit-first-" + u.id;
        firstInput.value = u.first_name || "";
        var lastInput = document.createElement("input");
        lastInput.className = "form-control form-control-sm";
        lastInput.placeholder = "Last";
        lastInput.id = "edit-last-" + u.id;
        lastInput.value = u.last_name || "";
        nameWrap.appendChild(firstInput);
        nameWrap.appendChild(lastInput);
        nameTd.appendChild(nameWrap);
      } else {
        emailTd.textContent = u.email;
        nameTd.textContent = ((u.first_name || "") + " " + (u.last_name || "")).trim() || "\u2014";
      }
      tr.appendChild(emailTd);
      tr.appendChild(nameTd);

      var roleTd = document.createElement("td");
      roleTd.textContent = ROLE_LABELS[u.role] || u.role;
      tr.appendChild(roleTd);

      var td = document.createElement("td");
      td.className = "text-end";
      var wrap = document.createElement("div");
      wrap.className = "d-flex gap-2 justify-content-end";
      if (editing) {
        var save = document.createElement("button");
        save.type = "button";
        save.className = "btn btn-sm btn-primary";
        save.textContent = "Save";
        save.addEventListener("click", function () { doSaveEdit(u); });
        wrap.appendChild(save);
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn-sm btn-outline-secondary";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", function () {
          state.editingUserId = null;
          usersStatus("");
          renderUsers();
        });
        wrap.appendChild(cancel);
      } else {
        if (canEditUser(u)) {
          var e = document.createElement("button");
          e.type = "button";
          e.className = "btn btn-sm btn-outline-light";
          e.textContent = "Edit";
          e.addEventListener("click", function () {
            state.editingUserId = u.id;
            usersStatus("");
            renderUsers();
          });
          wrap.appendChild(e);
        }
        if (canRotate) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm btn-outline-warning";
          b.textContent = "Rotate";
          b.addEventListener("click", function () { doRotate(u); });
          wrap.appendChild(b);
          var d = document.createElement("button");
          d.type = "button";
          d.className = "btn btn-sm btn-outline-danger";
          d.textContent = "Delete";
          d.addEventListener("click", function () { doDeleteUser(u); });
          wrap.appendChild(d);
        }
      }
      if (wrap.childNodes.length) {
        td.appendChild(wrap);
      } else {
        td.textContent = "\u2014";
      }
      tr.appendChild(td);
      body.appendChild(tr);
    });
    $("label-users-meta").textContent =
      state.users.length + (state.users.length === 1 ? " account" : " accounts");
  }

  // Reads the three inline inputs a row's Edit mode created and PUTs whichever changed.
  // Stays in edit mode on failure (server detail shown via usersStatus) so nothing typed
  // is lost - only a successful save clears editingUserId and re-renders from fresh data.
  function doSaveEdit(u) {
    var email = $("edit-email-" + u.id).value.trim();
    var first = $("edit-first-" + u.id).value.trim();
    var last = $("edit-last-" + u.id).value.trim();
    api("/users/" + u.id, "PUT", { email: email, first_name: first, last_name: last })
      .then(function () {
        state.editingUserId = null;
        usersStatus("");
        return loadUsers();
      })
      .catch(function (e) {
        usersStatus((e.data && e.data.detail) || "Could not save changes");
      });
  }

  function fillRoleOptions() {
    var sel = $("select-user-role");
    sel.innerHTML = "";
    // An Admin's ceiling is Admin - the server enforces it, and offering an option that
    // will come back 403 is worse than not offering it. Only a super admin sees the
    // elevated roles at all.
    var roles = isSuperAdmin()
      ? ["user", "super_user", "admin", "super_admin"]
      : ["user", "super_user"];
    roles.forEach(function (r) {
      var o = document.createElement("option");
      o.value = r;
      o.textContent = ROLE_LABELS[r] || r;
      sel.appendChild(o);
    });
  }

  function showNewKey(who, key, link) {
    $("label-new-key-who").textContent = who;
    $("field-new-key").value = key;
    if (link) {
      $("field-new-link").value = link;
      show($("row-new-link"));
      hide($("label-new-link-missing"));
    } else {
      $("field-new-link").value = "";
      hide($("row-new-link"));
      show($("label-new-link-missing"));
    }
    show($("panel-new-key"));
  }

  function doCreateUser() {
    var err = $("new-user-error");
    hide(err);
    var email = $("field-user-email").value.trim();
    if (!email) {
      err.textContent = "Enter an email address";
      show(err);
      return;
    }
    api("/users", "POST", {
      email: email,
      first_name: $("field-user-first").value.trim(),
      last_name: $("field-user-last").value.trim(),
      role: $("select-user-role").value
    }).then(function (data) {
      $("field-user-email").value = "";
      $("field-user-first").value = "";
      $("field-user-last").value = "";
      hide($("form-new-user"));
      showNewKey(data.email, data.api_key, data.install_link);
      return loadUsers();
    }).catch(function (e) {
      err.textContent = (e.data && e.data.detail) || "Could not create the account";
      show(err);
    });
  }

  function doRotate(u) {
    // Confirm, because the old key stops working the instant this returns and whoever is
    // holding it finds out by the app failing.
    if (!window.confirm("New key for " + u.email + "?\n\nTheir current key stops working immediately.")) {
      return;
    }
    api("/users/" + u.id + "/rotate-key", "POST", {}).then(function (data) {
      showNewKey(u.email, data.api_key, data.install_link);
    }).catch(function (e) {
      usersStatus((e.data && e.data.detail) || "Could not rotate the key");
    });
  }

  // NOT REVERSIBLE. Deletes the account and every conversation, transcript and summary it
  // owns - not an archive, a hard delete (see users.delete_account()). Typed-confirmation
  // rather than a plain window.confirm(): Rotate above is a plain confirm because it is
  // recoverable in spirit (a new key can be issued again); this is not, so the bar for a
  // stray click is higher. Typing the email is also the one piece of friction that forces
  // a second look at WHICH row got clicked in a table that can run to hundreds of rows.
  function doDeleteUser(u) {
    var typed = window.prompt(
      "Delete " + u.email + "?\n\nThis permanently deletes the account and everything it " +
      "owns - every conversation, transcript and summary. Not an archive; not reversible.\n\n" +
      "Type the email address to confirm:");
    if (typed === null) { return; }
    if (typed.trim().toLowerCase() !== u.email.toLowerCase()) {
      usersStatus("Email did not match - nothing deleted.");
      return;
    }
    api("/users/" + u.id, "DELETE").then(function () {
      usersStatus("");
      return loadUsers();
    }).catch(function (e) {
      usersStatus((e.data && e.data.detail) || "Could not delete the account");
    });
  }

  function showBrowse() {
    hide($("pane-editor"));
    hide($("pane-premade"));
    hide($("pane-users"));
    show($("pane-premades-browse"));
    state.premadeId = null;
    renderBrowse();
  }

  function renderChips() {
    var box = $("chips-section");
    box.innerHTML = "";
    var opts = [{ v: "", t: "All sections" }];
    ((state.taxonomy && state.taxonomy.sections) || []).forEach(function (sec) {
      opts.push({ v: sec, t: sectionLabel(sec) });
    });
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ctl-chip" + (state.filter.section === o.v ? " is-on" : "");
      b.textContent = o.t;
      b.addEventListener("click", function () {
        state.filter.section = o.v;
        renderChips();
        renderBrowse();
      });
      box.appendChild(b);
    });
  }

  function matches(p) {
    var f = state.filter;
    if (f.section && p.section !== f.section) { return false; }
    if (f.category && p.category !== f.category) { return false; }
    if (f.q) {
      var hay = (p.name + " " + p.id + " " + (p.category || "")).toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) === -1) { return false; }
    }
    return true;
  }

  function sorted(rows) {
    var k = state.sort.key, dir = state.sort.dir;
    return rows.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (k === "weight") { return (x - y) * dir; }
      x = String(x || "").toLowerCase();
      y = String(y || "").toLowerCase();
      if (x < y) { return -1 * dir; }
      if (x > y) { return 1 * dir; }
      // Stable-ish secondary: weight, so a section sort still reads in display order.
      return (a.weight - b.weight);
    });
  }

  function renderBrowse() {
    var body = $("rows-premades");
    body.innerHTML = "";
    var rows = sorted(state.premades.filter(matches));
    var live = state.premades.filter(function (p) { return p.live; }).length;
    var dirty = state.premades.filter(function (p) { return p.draft_dirty; }).length;
    $("label-browse-meta").textContent =
      state.premades.length + " total · " + live + " live · " + dirty +
      " with unsaved drafts" +
      (rows.length !== state.premades.length ? " · showing " + rows.length : "");
    if (!rows.length) { show($("browse-empty")); return; }
    hide($("browse-empty"));
    rows.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.className = "ctl-row";
      tr.tabIndex = 0;
      function cell(text, cls) {
        var td = document.createElement("td");
        if (cls) { td.className = cls; }
        td.textContent = text;
        tr.appendChild(td);
        return td;
      }
      cell(p.name, "ctl-cell__name");
      cell(p.id, "ctl-cell__id");
      cell(sectionLabel(p.section));
      cell(p.category || "—");
      cell(String(p.weight), "ctl-th--num");
      var liveTd = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "badge " + (p.live ? "ctl-badge-live" : "ctl-badge-off");
      badge.textContent = p.live ? "v" + p.published_version : "not live";
      liveTd.appendChild(badge);
      tr.appendChild(liveTd);
      var draftTd = document.createElement("td");
      if (p.draft_dirty) {
        var d = document.createElement("span");
        d.className = "badge ctl-badge-draft";
        d.textContent = "unsaved";
        draftTd.appendChild(d);
      } else {
        draftTd.textContent = "—";
      }
      tr.appendChild(draftTd);
      tr.addEventListener("click", function () { selectPremade(p.id); });
      tr.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { selectPremade(p.id); }
      });
      body.appendChild(tr);
    });
  }

  function showPremadePane() {
    hide($("pane-editor"));
    hide($("pane-premades-browse"));
    show($("pane-premade"));
  }

  function selectPremade(pid) {
    state.premadeId = pid;
    state.coreId = null;
    api("/premades/" + pid).then(function (entry) {
      state.premade = entry;
      showPremadePane();
      renderPremadeRail();
      renderPremadeEditor(entry);
    }).catch(function (e) { premadeStatus(detail(e) || "Could not load that entry.", "bad"); });
  }

  function renderPremadeEditor(entry) {
    $("label-premade-name").textContent = entry.name || entry.id;
    $("label-premade-meta").textContent =
      entry.id + " · Live v" + entry.published_version +
      " · Latest v" + entry.latest_version +
      (entry.published_version ? "" : " · never promoted");
    $("select-premade-section").value = entry.section;
    $("select-premade-category").value = entry.category || "";
    $("input-premade-weight").value = entry.weight;
    $("check-premade-editable").checked = !!entry.editable;
    $("input-premade-display-name").value = entry.name || "";
    $("input-premade-description").value = entry.description || "";
    $("input-author-handle").value = (entry.author && entry.author.handle) || "";
    $("input-author-bio").value = (entry.author && entry.author.bio) || "";
    $("input-author-links").value =
      ((entry.author && entry.author.links) || []).join("\n");
    $("text-premade-instructions").value = entry.draft.instructions || "";
    premadeSourceHint(entry.section);
    toggleAuthorBlock(entry.section);
    renderPremadeProblems(entry.problems);
    premadeStatus("");
    renderVersions(entry);
  }

  function premadeSourceHint(section) {
    var hint = { house: "Grabs resolve as a POINTER — a promoted fix reaches everyone still on it.",
                 featured: "Grabs take a COPY at add time.",
                 open_stack: "Grabs take a COPY at add time." };
    $("hint-premade-source").textContent = hint[section] || "";
  }

  function toggleAuthorBlock(section) {
    if (section === "featured") { show($("block-premade-author")); }
    else { hide($("block-premade-author")); }
  }

  function renderVersions(entry) {
    var list = $("list-premade-versions");
    list.innerHTML = "";
    if (!entry.versions.length) {
      var none = document.createElement("li");
      none.className = "ctl-rail__empty";
      none.textContent = "No saved versions yet — the draft has never been frozen.";
      list.appendChild(none);
      return;
    }
    entry.versions.forEach(function (v) {
      var li = document.createElement("li");
      li.className = "ctl-version";
      var label = document.createElement("span");
      label.textContent = "v" + v.version + (v.note ? " — " + v.note : "");
      if (v.version === entry.published_version) {
        var live = document.createElement("span");
        live.className = "badge ctl-badge-live";
        live.textContent = "Live";
        label.appendChild(document.createTextNode(" "));
        label.appendChild(live);
      }
      li.appendChild(label);
      if (v.version !== entry.published_version) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-sm btn-outline-light";
        btn.textContent = "Roll back to this";
        btn.addEventListener("click", function () { doPremadeRollback(v.version); });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
  }

  function queuePremadeDraft() {
    if (state.premadeTimer) { clearTimeout(state.premadeTimer); }
    state.premadeTimer = setTimeout(function () {
      api("/premades/" + state.premadeId + "/draft", "PUT", {
        name: $("input-premade-display-name").value,
        description: $("input-premade-description").value,
        instructions: $("text-premade-instructions").value
      }).then(function (res) {
        renderPremadeProblems(res.problems);
        premadeStatus("Draft saved.", "ok");
        loadPremades();
      }).catch(function (e) {
        // The token and === rejections land here. They are the point of the check,
        // so show exactly what the server refused rather than a generic failure.
        premadeStatus(detail(e) || "Draft not saved.", "bad");
      });
    }, 700);
  }

  function doPremadeMeta() {
    var links = $("input-author-links").value
      .split(/[\n,]/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length; });
    api("/premades/" + state.premadeId + "/meta", "PUT", {
      section: $("select-premade-section").value,
      category: $("select-premade-category").value,
      weight: parseInt($("input-premade-weight").value, 10) || 0,
      editable: $("check-premade-editable").checked,
      name: $("input-premade-display-name").value,
      description: $("input-premade-description").value,
      author_handle: $("input-author-handle").value,
      author_bio: $("input-author-bio").value,
      author_links: links
    }).then(function () {
      premadeStatus("Metadata saved. Takes effect immediately — it is not versioned.", "ok");
      toggleAuthorBlock($("select-premade-section").value);
      premadeSourceHint($("select-premade-section").value);
      loadPremades();
    }).catch(function (e) {
      var problems = e && e.data && e.data.detail && e.data.detail.problems;
      if (problems) { renderPremadeProblems(problems); }
      premadeStatus(detail(e) || "Could not save metadata.", "bad");
    });
  }

  function doPremadeSaveVersion() {
    api("/premades/" + state.premadeId + "/save_version", "POST",
        { note: $("input-premade-note").value })
      .then(function (res) {
        bootstrap.Modal.getOrCreateInstance($("modal-premade-save")).hide();
        $("input-premade-note").value = "";
        premadeStatus("Saved as version " + res.version + ". Not Live until you promote it.", "ok");
        selectPremade(state.premadeId);
        loadPremades();
      })
      .catch(function (e) { premadeStatus(detail(e) || "Could not save.", "bad"); });
  }

  function doPremadePromote() {
    api("/premades/" + state.premadeId + "/promote", "POST", {})
      .then(function (res) {
        premadeStatus("Live now — version " + res.published_version +
                      ". Visible in the app's gallery on its next fetch.", "ok");
        selectPremade(state.premadeId);
      })
      .catch(function (e) {
        var problems = e && e.data && e.data.detail && e.data.detail.problems;
        if (problems) { renderPremadeProblems(problems); }
        premadeStatus(detail(e) || "Could not promote.", "bad");
      });
  }

  function doPremadeRollback(version) {
    api("/premades/" + state.premadeId + "/rollback", "POST", { version: version })
      .then(function (res) {
        premadeStatus("Rolled back — v" + res.copied_from + " copied forward as v" +
                      res.published_version + " and promoted. Nothing was rewritten.", "ok");
        selectPremade(state.premadeId);
      })
      .catch(function (e) { premadeStatus(detail(e) || "Could not roll back.", "bad"); });
  }

  function doPremadeUnpublish() {
    api("/premades/" + state.premadeId + "/unpublish", "POST", {})
      .then(function () {
        premadeStatus("Unpublished. Gone from the gallery; history and text kept.", "ok");
        selectPremade(state.premadeId);
        loadPremades();
      })
      .catch(function (e) { premadeStatus(detail(e) || "Could not unpublish.", "bad"); });
  }

  function doPremadeDelete() {
    api("/premades/" + state.premadeId, "DELETE")
      .then(function () {
        premadeStatus("");
        state.premade = null;
        loadPremades().then(showBrowse);
      })
      .catch(function (e) { premadeStatus(detail(e) || "Could not delete.", "bad"); });
  }

  function doNewPremade() {
    var box = $("new-premade-error");
    hide(box);
    api("/premades", "POST", {
      pid: $("input-new-pid").value.trim().toLowerCase(),
      section: $("select-new-section").value,
      name: $("input-new-name").value,
      category: $("select-new-category").value
    }).then(function (res) {
      bootstrap.Modal.getOrCreateInstance($("modal-new-premade")).hide();
      $("input-new-pid").value = "";
      $("input-new-name").value = "";
      loadPremades().then(function () { selectPremade(res.id); });
    }).catch(function (e) {
      box.textContent = detail(e) || "Could not create that entry.";
      show(box);
    });
  }

  function doSubmissions() {
    api("/premades/submissions").then(function (data) {
      var list = $("list-submissions");
      list.innerHTML = "";
      if (!data.submissions.length) {
        var none = document.createElement("li");
        none.className = "ctl-rail__empty";
        none.textContent = "Queue is empty. No submission path exists yet.";
        list.appendChild(none);
      } else {
        data.submissions.forEach(function (sub) {
          var li = document.createElement("li");
          li.className = "ctl-version";
          li.textContent = sub.name + " — " + sub.state;
          list.appendChild(li);
        });
      }
      bootstrap.Modal.getOrCreateInstance($("modal-submissions")).show();
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

    $("btn-open-users").addEventListener("click", showUsers);
    $("btn-new-user").addEventListener("click", function () {
      hide($("new-user-error"));
      fillRoleOptions();
      show($("form-new-user"));
      $("field-user-email").focus();
    });
    $("btn-cancel-user").addEventListener("click", function () { hide($("form-new-user")); });
    $("btn-create-user").addEventListener("click", doCreateUser);
    $("btn-dismiss-key").addEventListener("click", function () {
      $("field-new-key").value = "";
      $("field-new-link").value = "";
      hide($("panel-new-key"));
    });
    $("btn-copy-key").addEventListener("click", function () {
      var f = $("field-new-key");
      f.select();
      // execCommand rather than navigator.clipboard: the console is served over plain
      // http at the moment and the async Clipboard API is gated on a secure context, so
      // the modern call silently does nothing there.
      try { document.execCommand("copy"); } catch (e) { /* user can still select it */ }
      $("btn-copy-key").textContent = "Copied";
      setTimeout(function () { $("btn-copy-key").textContent = "Copy"; }, 1200);
    });
    $("btn-copy-link").addEventListener("click", function () {
      var f = $("field-new-link");
      f.select();
      try { document.execCommand("copy"); } catch (e) { /* user can still select it */ }
      $("btn-copy-link").textContent = "Copied";
      setTimeout(function () { $("btn-copy-link").textContent = "Copy link"; }, 1200);
    });

    $("btn-open-premades").addEventListener("click", showBrowse);
    $("btn-back-premades").addEventListener("click", showBrowse);
    $("input-search").addEventListener("input", function () {
      state.filter.q = this.value.trim();
      renderBrowse();
    });
    $("select-filter-category").addEventListener("change", function () {
      state.filter.category = this.value;
      renderBrowse();
    });
    Array.prototype.forEach.call(document.querySelectorAll(".ctl-th[data-sort]"),
      function (th) {
        th.addEventListener("click", function () {
          var key = th.getAttribute("data-sort");
          if (state.sort.key === key) { state.sort.dir = -state.sort.dir; }
          else { state.sort.key = key; state.sort.dir = 1; }
          renderBrowse();
        });
      });
    $("toggle-cores").addEventListener("click", function () {
      toggleGroup("toggle-cores", "list-cores");
    });
    $("btn-new-premade").addEventListener("click", function () {
      $("new-premade-error").classList.add("ctl-hidden");
      bootstrap.Modal.getOrCreateInstance($("modal-new-premade")).show();
    });
    $("btn-new-premade-confirm").addEventListener("click", doNewPremade);
    $("btn-submissions").addEventListener("click", doSubmissions);
    $("btn-premade-save").addEventListener("click", function () {
      bootstrap.Modal.getOrCreateInstance($("modal-premade-save")).show();
    });
    $("btn-premade-save-confirm").addEventListener("click", doPremadeSaveVersion);
    $("btn-premade-promote").addEventListener("click", doPremadePromote);
    $("btn-premade-unpublish").addEventListener("click", doPremadeUnpublish);
    $("btn-premade-delete").addEventListener("click", doPremadeDelete);
    $("btn-premade-meta").addEventListener("click", doPremadeMeta);
    ["text-premade-instructions", "input-premade-display-name", "input-premade-description"]
      .forEach(function (id) {
        $(id).addEventListener("input", queuePremadeDraft);
      });

    // Already signed in? Skip the login screen.
    api("/me").then(function (data) { enterConsole(data); }).catch(function () { /* show login */ });
  });
})();
