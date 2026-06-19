define(["jquery"], function ($) {
  var CustomWidget = function () {
    var self = this,
      system = self.system(),
      langs = self.langs;

    // ---------- Функции API ----------

    function getFieldValues(contact, fieldCode) {
      if (!contact.custom_fields_values) return [];
      var field = contact.custom_fields_values.find(function (cf) {
        return cf.field_code === fieldCode;
      });
      if (!field || !field.values) return [];
      return field.values.map(function (v) { return (v.value || "").trim(); }).filter(Boolean);
    }

    function getGroupKey(values) {
      if (!values || values.length === 0) return null;
      return values.slice().sort().join("||");
    }

    function fetchAllContacts(token) {
      return new Promise(function (resolve, reject) {
        var all = [];
        var page = 1;
        var limit = 250;
        function load() {
          self.crm_post("/api/v4/contacts?page=" + page + "&limit=" + limit, {}, function (resp) {
            try {
              var data = JSON.parse(resp);
              if (data._embedded && data._embedded.contacts) {
                all = all.concat(data._embedded.contacts);
                if (data._embedded.contacts.length < limit) resolve(all);
                else { page++; load(); }
              } else resolve(all);
            } catch (e) { reject(e); }
          }, "text", function () { reject(new Error("Ошибка загрузки")); });
        }
        load();
      });
    }

    function findDuplicateGroups(contacts, tgCode) {
      var phoneMap = {}, tgMap = {}, byId = {};
      contacts.forEach(function (c) {
        byId[c.id] = c;
        var pk = getGroupKey(getFieldValues(c, "PHONE"));
        if (pk) { if (!phoneMap[pk]) phoneMap[pk] = []; phoneMap[pk].push(c.id); }
        var tk = getGroupKey(getFieldValues(c, tgCode));
        if (tk) { if (!tgMap[tk]) tgMap[tk] = []; tgMap[tk].push(c.id); }
      });
      var processed = new Set(), groups = [];
      function addGroup(ids) {
        ids = ids.filter(function (id) { return !processed.has(id); });
        if (ids.length < 2) return;
        ids.sort(function (a, b) { return a - b; });
        ids.forEach(function (id) { processed.add(id); });
        groups.push({ master_id: ids[0], ids: ids, contacts: ids.map(function (id) { return byId[id]; }).filter(Boolean) });
      }
      Object.keys(phoneMap).forEach(function (k) { addGroup(phoneMap[k]); });
      Object.keys(tgMap).forEach(function (k) {
        var ids = tgMap[k].filter(function (id) { return !processed.has(id); });
        if (ids.length >= 2) addGroup(ids);
      });
      return groups;
    }

    function apiGet(url, token) {
      return new Promise(function (resolve, reject) {
        self.crm_post(url, {}, function (resp) {
          try { resolve(JSON.parse(resp)); } catch (e) { reject(e); }
        }, "text", function () { reject(new Error("GET error")); });
      });
    }

    function apiPatch(url, data, token) {
      return new Promise(function (resolve, reject) {
        $.ajax({
          url: url, type: "PATCH",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          data: JSON.stringify(data)
        }).done(resolve).fail(reject);
      });
    }

    function apiDelete(url, token) {
      return new Promise(function (resolve, reject) {
        $.ajax({
          url: url, type: "DELETE",
          headers: { "Authorization": "Bearer " + token }
        }).done(resolve).fail(reject);
      });
    }

    function apiPost(url, data, token) {
      return new Promise(function (resolve, reject) {
        $.ajax({
          url: url, type: "POST",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          data: JSON.stringify(data)
        }).done(resolve).fail(reject);
      });
    }

    async function mergeGroup(group, token, tgCode) {
      var masterId = group.master_id;
      var dupIds = group.ids.filter(function (id) { return id !== masterId; });
      var master = await apiGet("/api/v4/contacts/" + masterId, token);
      for (var d = 0; d < dupIds.length; d++) {
        var dupId = dupIds[d];
        var dup = await apiGet("/api/v4/contacts/" + dupId, token);
        if (!dup) continue;
        var updates = {};
        if (dup.name && (!master.name || master.name.trim() === "")) updates.name = dup.name;
        if (dup.custom_fields_values) {
          var newFields = [];
          dup.custom_fields_values.forEach(function (cf) {
            if (cf.field_code === "PHONE") {
              var allPhones = [...new Set([...getFieldValues(master, "PHONE"), ...getFieldValues(dup, "PHONE")])];
              if (allPhones.length) newFields.push({ field_code: "PHONE", values: allPhones.map(function (p) { return { value: p, enum_id: "WORK" }; }) });
            } else if (cf.field_code === tgCode) {
              var allTg = [...new Set([...getFieldValues(master, tgCode), ...getFieldValues(dup, tgCode)])];
              if (allTg.length) newFields.push({ field_code: tgCode, values: allTg.map(function (t) { return { value: t }; }) });
            } else {
              var exists = master.custom_fields_values && master.custom_fields_values.find(function (f) { return f.field_code === cf.field_code; });
              if (!exists || !exists.values || !exists.values.length) newFields.push(cf);
            }
          });
          if (newFields.length) updates.custom_fields_values = newFields;
        }
        if (Object.keys(updates).length) await apiPatch("/api/v4/contacts/" + masterId, updates, token);
        try {
          var links = await apiGet("/api/v4/contacts/" + dupId + "/links", token);
          if (links._embedded && links._embedded.links) {
            var leads = links._embedded.links.filter(function (l) { return l.to_entity_type === "leads"; });
            for (var i = 0; i < leads.length; i++) {
              await apiPost("/api/v4/contacts/" + masterId + "/link", [{ to_entity_id: leads[i].to_entity_id, to_entity_type: "leads", metadata: leads[i].metadata || {} }], token);
            }
          }
        } catch (e) {}
        await apiDelete("/api/v4/contacts/" + dupId, token);
      }
    }

    // ---------- Уведомление ----------

    function notify(msg, isErr) {
      var $n = $('<div style="position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;border-radius:6px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:400px;"></div>');
      $n.css("background", isErr ? "#ffebee" : "#e8f5e9");
      $n.css("color", isErr ? "#c62828" : "#2e7d32");
      $n.css("border", isErr ? "1px solid #ef9a9a" : "1px solid #a5d6a7");
      $n.text(msg);
      $("body").append($n);
      setTimeout(function () { $n.fadeOut(300, function () { $n.remove(); }); }, 4000);
    }

    // ---------- UI в карточке ----------

    function initCard() {
      var settings = self.get_settings();
      var token = settings.api_token || "";
      var tgCode = settings.telegram_field_code || "TELEGRAM_USERNAME_ID";

      var html = '<div style="padding:12px 15px;font-size:13px;line-height:1.5;">' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:10px;color:#333;">' + langs.widget.short_description + '</div>';

      if (!token) html += '<p style="color:#888;margin:0 0 10px;">Укажите API токен в настройках</p>';

      html += '<button class="adu-scan" style="width:100%;padding:8px;font-size:13px;cursor:pointer;border:none;border-radius:4px;background:#4CAF50;color:#fff;margin-bottom:6px;">Сканировать</button>' +
        '<button class="adu-set" style="width:100%;padding:8px;font-size:13px;cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#f5f5f5;color:#555;">Настройки</button></div>';

      var wCode = self.params.widget_code;
      var $body = $(".card-widgets__widget-" + wCode + " .card-widgets__widget__body");
      if (!$body.length) $body = $(".card-widgets__widget__body").first();
      if ($body.length) $body.html(html);

      $(".adu-scan").off().on("click", function () { doScan(token, tgCode, $(this)); });
      $(".adu-set").off().on("click", function () { doSettings(); });
    }

    async function doScan(token, tgCode, $btn) {
      if (!token) { notify("Сначала укажите API токен", true); return; }
      $btn.prop("disabled", true).text("Поиск...");
      try {
        var contacts = await fetchAllContacts(token);
        var groups = findDuplicateGroups(contacts, tgCode);
        $btn.prop("disabled", false).text("Сканировать");
        if (!groups.length) { notify("Дубликаты не найдены", false); return; }
        showMergeModal(groups, token, tgCode);
      } catch (e) {
        $btn.prop("disabled", false).text("Сканировать");
        notify("Ошибка: " + (e.message || ""), true);
      }
    }

    function showMergeModal(groups, token, tgCode) {
      var html = '<div class="adu-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99998;"></div>' +
        '<div class="adu-modal" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:99999;width:520px;max-height:80vh;overflow-y:auto;padding:20px;">' +
        '<h3 style="margin:0 0 12px;font-size:16px;">Найдено групп: ' + groups.length + '</h3>';

      groups.forEach(function (g, idx) {
        html += '<div class="adu-grp" style="border:1px solid #e0e0e0;border-radius:6px;padding:10px;margin-bottom:8px;">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:6px;">Группа ' + (idx + 1) + ' (' + g.ids.length + ' конт.)</div>';
        g.contacts.forEach(function (c) {
          html += '<div style="padding:2px 6px;font-size:12px;' + (c.id === g.master_id ? 'background:#e8f5e9;font-weight:bold;' : '') + '">' + c.name + ' (ID:' + c.id + ')' + (c.id === g.master_id ? ' ← главный' : '') + '</div>';
        });
        html += '<button class="adu-mrg" data-idx="' + idx + '" style="margin-top:8px;padding:5px 12px;font-size:12px;cursor:pointer;background:#1976d2;color:#fff;border:none;border-radius:4px;">Объединить</button></div>';
      });

      html += '<div style="text-align:right;margin-top:10px;"><button class="adu-close" style="padding:6px 16px;cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#fff;">Закрыть</button></div></div>';
      $("body").append(html);

      $(".adu-close, .adu-overlay").on("click", function () { $(".adu-modal, .adu-overlay").remove(); });
      $(".adu-mrg").on("click", async function () {
        var idx = parseInt($(this).data("idx"));
        var $btn = $(this);
        var $grp = $btn.closest(".adu-grp");
        $btn.prop("disabled", true).text("Объединение...");
        try {
          await mergeGroup(groups[idx], token, tgCode);
          $btn.text("✅ Готово");
          $grp.fadeOut(300);
          notify("Объединено!", false);
        } catch (e) {
          $btn.prop("disabled", false).text("Объединить");
          notify("Ошибка: " + (e.message || ""), true);
        }
      });
    }

    function doSettings() {
      var s = self.get_settings();
      var html = '<div class="adu-overlay" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99998;"></div>' +
        '<div class="adu-modal" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:99999;width:440px;padding:24px;">' +
        '<h3 style="margin:0 0 16px;font-size:18px;">Настройки</h3>' +
        '<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">API токен</label>' +
        '<input class="adu-tok" type="text" value="' + (s.api_token || "") + '" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;"></div>' +
        '<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px;">Код поля Telegram</label>' +
        '<input class="adu-tg" type="text" value="' + (s.telegram_field_code || "TELEGRAM_USERNAME_ID") + '" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="adu-can" style="padding:8px 16px;cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#fff;font-size:13px;">Отмена</button>' +
        '<button class="adu-sav" style="padding:8px 16px;cursor:pointer;background:#1976d2;color:#fff;border:none;border-radius:4px;font-size:13px;">Сохранить</button></div></div>';
      $("body").append(html);

      $(".adu-can, .adu-overlay").on("click", function () { $(".adu-modal, .adu-overlay").remove(); });
      $(".adu-sav").on("click", function () {
        self.set_settings({
          api_token: $(".adu-tok").val(),
          telegram_field_code: $(".adu-tg").val()
        });
        notify("Сохранено", false);
        $(".adu-modal, .adu-overlay").remove();
        initCard();
      });
    }

    // ---------- Callbacks ----------

    this.callbacks = {
      render: function () {
        if (system.area === "ccard") {
          if (typeof APP !== "undefined" && APP.data && APP.data.current_card && APP.data.current_card.id === 0) return false;
          initCard();
        }
        return true;
      },
      init: function () { return true; },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () { return true; },
      contacts: { selected: function () {} },
      leads: { selected: function () {} },
      todo: { selected: function () {} }
    };

    return this;
  };
  return CustomWidget;
});
