define(['jquery'], function ($) {
    var CustomWidget = function () {
        var self = this;
        var system = self.system();
        var langs = self.langs;

        // ---------- Retry-обёртка для API-запросов ----------
        function apiCall(method, url, data, token, retries) {
            retries = retries || 3;
            var opts = {
                url: url,
                type: method,
                headers: { 'Authorization': 'Bearer ' + token }
            };
            if (method === 'POST' || method === 'PATCH') {
                opts.contentType = 'application/json';
                opts.data = JSON.stringify(data);
            }
            if (method === 'GET' && data) {
                opts.data = data;
            }
            return attempt(0);
            function attempt(n) {
                return $.ajax(opts).catch(function (err) {
                    if (n < retries - 1 && isRetryable(err)) {
                        return new Promise(function (resolve) {
                            setTimeout(function () { resolve(attempt(n + 1)); }, 1000 * (n + 1));
                        });
                    }
                    throw err;
                });
            }
            function isRetryable(err) {
                if (!err) return false;
                var status = err.status || 0;
                // 429 = too many requests, 5xx = server errors, 0 = network error
                return status === 429 || status >= 500 || status === 0;
            }
        }

        function apiGet(endpoint, params, token) {
            return apiCall('GET', '/api/v4/' + endpoint, params, token);
        }

        function apiPatch(endpoint, data, token) {
            return apiCall('PATCH', '/api/v4/' + endpoint, data, token);
        }

        function apiDelete(endpoint, token) {
            return apiCall('DELETE', '/api/v4/' + endpoint, null, token);
        }

        function apiPost(endpoint, data, token) {
            return apiCall('POST', '/api/v4/' + endpoint, data, token);
        }

        function getFieldValues(contact, fieldCode) {
            if (!contact.custom_fields_values) return [];
            var field = contact.custom_fields_values.find(function (cf) {
                return cf.field_code === fieldCode;
            });
            if (!field || !field.values) return [];
            return field.values.map(function (v) { return (v.value || '').trim(); }).filter(Boolean);
        }

        function getGroupKey(values) {
            if (!values || values.length === 0) return null;
            return values.slice().sort().join('||');
        }

        // ---------- Загрузка ВСЕХ контактов (пагинация) ----------
        async function fetchAllContacts(token) {
            let allContacts = [];
            let page = 1;
            const limit = 250;
            while (true) {
                const resp = await apiGet('contacts', { page: page, limit: limit }, token);
                if (!resp._embedded || !resp._embedded.contacts) break;
                allContacts = allContacts.concat(resp._embedded.contacts);
                if (resp._embedded.contacts.length < limit) break;
                page++;
            }
            return allContacts;
        }

        // ---------- Поиск дубликатов по заданному массиву контактов ----------
        // Оптимизация: строим карту телефон→id и tg→id за один проход,
        // вместо вложенного цикла O(n²)
        function findDuplicateGroups(contacts, telegramFieldCode) {
            // Строим карты: значение поля → список id
            var phoneMap = {};
            var tgMap = {};
            var contactsById = {};
            contacts.forEach(function (c) {
                contactsById[c.id] = c;
                var phones = getFieldValues(c, 'PHONE');
                var phoneKey = getGroupKey(phones);
                if (phoneKey) {
                    if (!phoneMap[phoneKey]) phoneMap[phoneKey] = [];
                    phoneMap[phoneKey].push(c.id);
                }
                var tgs = getFieldValues(c, telegramFieldCode);
                var tgKey = getGroupKey(tgs);
                if (tgKey) {
                    if (!tgMap[tgKey]) tgMap[tgKey] = [];
                    tgMap[tgKey].push(c.id);
                }
            });

            // Собираем группы
            var processed = new Set();
            var groups = [];

            function addGroup(ids) {
                ids = ids.filter(function (id) { return !processed.has(id); });
                if (ids.length < 2) return;
                ids.sort(function (a, b) { return a - b; });
                processed.add(ids[0]);
                var gContacts = ids.map(function (id) { return contactsById[id]; }).filter(Boolean);
                groups.push({
                    master_id: ids[0],
                    ids: ids,
                    contacts: gContacts
                });
                ids.forEach(function (id) { processed.add(id); });
            }

            // По телефону
            Object.keys(phoneMap).forEach(function (key) {
                addGroup(phoneMap[key]);
            });

            // По Telegram (пропускаем уже обработанные)
            Object.keys(tgMap).forEach(function (key) {
                var ids = tgMap[key].filter(function (id) { return !processed.has(id); });
                if (ids.length >= 2) addGroup(ids);
            });

            return groups;
        }

        // ---------- Объединение группы ----------
        async function mergeGroup(group, token, telegramFieldCode) {
            const masterId = group.master_id;
            const masterResp = await apiGet('contacts/' + masterId, {}, token);
            const master = masterResp;
            const duplicateIds = group.ids.filter(id => id !== masterId);

            for (const dupId of duplicateIds) {
                const dupResp = await apiGet('contacts/' + dupId, {}, token);
                const dup = dupResp;
                if (!dup) continue;

                const updates = {};

                // Имя — если у мастера пусто, берём от дубликата
                if (dup.name && (!master.name || master.name.trim() === '')) {
                    updates.name = dup.name;
                }

                // Поля
                if (dup.custom_fields_values) {
                    const newFields = [];
                    dup.custom_fields_values.forEach(function (cf) {
                        if (cf.field_code === 'PHONE') {
                            var masterPhones = getFieldValues(master, 'PHONE');
                            var dupPhones = getFieldValues(dup, 'PHONE');
                            var allPhones = [...new Set([...masterPhones, ...dupPhones])];
                            if (allPhones.length > 0) {
                                newFields.push({
                                    field_code: 'PHONE',
                                    values: allPhones.map(function (p) {
                                        return { value: p, enum_id: 'WORK' };
                                    })
                                });
                            }
                        } else if (cf.field_code === telegramFieldCode) {
                            var masterTg = getFieldValues(master, telegramFieldCode);
                            var dupTg = getFieldValues(dup, telegramFieldCode);
                            var allTg = [...new Set([...masterTg, ...dupTg])];
                            if (allTg.length > 0) {
                                newFields.push({
                                    field_code: telegramFieldCode,
                                    values: allTg.map(function (t) { return { value: t }; })
                                });
                            }
                        } else {
                            var existing = master.custom_fields_values?.find(f => f.field_code === cf.field_code);
                            if (!existing || !existing.values || existing.values.length === 0) {
                                newFields.push(cf);
                            }
                        }
                    });
                    if (newFields.length > 0) updates.custom_fields_values = newFields;
                }

                if (Object.keys(updates).length > 0) {
                    await apiPatch('contacts/' + masterId, updates, token);
                }

                // Перенос сделок
                try {
                    const linksResp = await apiGet('contacts/' + dupId + '/links', {}, token);
                    if (linksResp._embedded && linksResp._embedded.links) {
                        const leadLinks = linksResp._embedded.links.filter(l => l.to_entity_type === 'leads');
                        for (const link of leadLinks) {
                            await apiPost('contacts/' + masterId + '/link', [{
                                to_entity_id: link.to_entity_id,
                                to_entity_type: 'leads',
                                metadata: link.metadata || {}
                            }], token);
                        }
                    }
                } catch (e) {
                    console.warn('Не удалось перенести сделки для контакта ' + dupId, e);
                }

                // Удаляем дубликат
                await apiDelete('contacts/' + dupId, token);
            }
        }

        // ---------- Интерфейс настроек ----------
        function initSettingsUI() {
            self.getTemplate('widget', function (template) {
                var settings = self.get_settings();
                var html = template.render({ lang: langs, settings: settings });
                var $container = $('.widget-settings__body').first();
                if (!$container.length) {
                    $container = $('<div class="widget-settings__body"></div>').appendTo('form');
                }
                $container.html(html);

                var $scanBtn = $container.find('.merge-scan-btn');
                var $status = $container.find('.merge-status');
                var $error = $container.find('.merge-error');
                var $results = $container.find('.merge-results');
                var $groupsContainer = $container.find('.groups-container');
                var $groupsCount = $container.find('.groups-count');

                $scanBtn.on('click', async function () {
                    var token = self.get_settings().api_token;
                    var tgCode = self.get_settings().telegram_field_code || 'TELEGRAM_USERNAME_ID';
                    if (!token) {
                        $error.text('Ошибка: не указан API токен в настройках виджета.').show();
                        return;
                    }

                    $scanBtn.prop('disabled', true);
                    $status.show();
                    $error.hide();
                    $results.hide();

                    try {
                        const allContacts = await fetchAllContacts(token);
                        const groups = findDuplicateGroups(allContacts, tgCode);
                        $status.hide();

                        if (groups.length === 0) {
                            $status.text(langs.interface.no_duplicates).show();
                            return;
                        }

                        $groupsCount.text(groups.length);
                        $groupsContainer.empty();

                        groups.forEach(function (group, idx) {
                            var $groupDiv = $('<div class="duplicate-group"></div>');
                            $groupDiv.append('<h5>Группа ' + (idx + 1) + ' (' + group.ids.length + ' контакта)</h5>');

                            group.contacts.forEach(function (c) {
                                var isMaster = c.id === group.master_id;
                                var $item = $('<div class="duplicate-item' + (isMaster ? ' master' : '') + '"></div>');
                                $item.text(c.name + ' (ID: ' + c.id + ')' + (isMaster ? ' ← Главный' : ''));
                                $groupDiv.append($item);
                            });

                            var $mergeBtn = $('<button class="merge-group-btn am-button am-button--primary">' + langs.interface.merge_button + '</button>');
                            $mergeBtn.on('click', async function () {
                                $mergeBtn.prop('disabled', true).text(langs.interface.merging);
                                try {
                                    await mergeGroup(group, token, tgCode);
                                    $mergeBtn.text(langs.interface.merged);
                                    notifyUser('Группа объединена (мастер ID: ' + group.master_id + ')', false);
                                    $groupDiv.fadeOut(500, function () {
                                        var remaining = $('.duplicate-group:visible').length;
                                        $groupsCount.text(remaining);
                                        if (remaining === 0) $results.hide();
                                    });
                                } catch (err) {
                                    $mergeBtn.prop('disabled', false).text(langs.interface.merge_button);
                                    $error.text(langs.interface.error + ': ' + (err.message || '')).show();
                                }
                            });
                            $groupDiv.append($mergeBtn);
                            $groupsContainer.append($groupDiv);
                        });

                        $results.show();
                    } catch (err) {
                        $status.hide();
                        $error.text(langs.interface.error + ': ' + (err.message || '')).show();
                    } finally {
                        $scanBtn.prop('disabled', false);
                    }
                });
            });
        }

        // ---------- Автоматическое объединение ----------
        async function handleAutoMerge(data) {
            var settings = self.get_settings();
            if (!settings.auto_merge) return;
            var token = settings.api_token;
            var tgCode = settings.telegram_field_code || 'TELEGRAM_USERNAME_ID';
            if (!token) return;

            var contactId = data.id;
            if (!contactId) return;

            try {
                var contactResp = await apiGet('contacts/' + contactId, {}, token);
                var contact = contactResp;
                if (!contact) return;

                var phoneKey = getGroupKey(getFieldValues(contact, 'PHONE'));
                var tgKey = getGroupKey(getFieldValues(contact, tgCode));
                if (!phoneKey && !tgKey) return;

                // Загружаем ВСЕ контакты для полного поиска дубликатов
                var allContacts = await fetchAllContacts(token);
                var candidates = allContacts.filter(function (c) {
                    if (c.id === contactId) return false;
                    if (phoneKey && getGroupKey(getFieldValues(c, 'PHONE')) === phoneKey) return true;
                    if (tgKey && getGroupKey(getFieldValues(c, tgCode)) === tgKey) return true;
                    return false;
                });

                if (candidates.length === 0) return;

                var groupContacts = [contact, ...candidates];
                var groupIds = groupContacts.map(c => c.id).sort((a,b) => a - b);
                var masterId = groupIds[0];
                var group = {
                    master_id: masterId,
                    ids: groupIds,
                    contacts: groupContacts
                };

                console.log(langs.interface.log_prefix + 'Найден дубликат для контакта ' + contactId);
                await mergeGroup(group, token, tgCode);
                console.log(langs.interface.log_prefix + 'Дубликаты объединены, мастер: ' + masterId);
                notifyUser('Автосклейка: дубликат объединён (мастер ID: ' + masterId + ')', false);
            } catch (e) {
                console.error(langs.interface.log_prefix + 'Ошибка автообъединения: ', e);
                notifyUser('Ошибка автосклейки: ' + (e.message || 'неизвестная ошибка'), true);
            }
        }

        // ---------- Уведомления для пользователя ----------
        function notifyUser(message, isError) {
            var $existing = $('.antidupl-notification');
            if ($existing.length) $existing.remove();

            var $notif = $('<div class="antidupl-notification" style="position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;border-radius:6px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:400px;"></div>');
            $notif.css('background', isError ? '#ffebee' : '#e8f5e9');
            $notif.css('color', isError ? '#c62828' : '#2e7d32');
            $notif.css('border', isError ? '1px solid #ef9a9a' : '1px solid #a5d6a7');
            $notif.text(message);
            $('body').append($notif);
            setTimeout(function () { $notif.fadeOut(300, function () { $notif.remove(); }); }, 5000);
        }

        // ---------- Рендеринг в карточке контакта ----------
        function initCardUI() {
            var settings = self.get_settings();
            if (!settings.api_token) {
                self.render_template({
                    caption: { class_name: 'antidupl-caption', html: langs.widget.short_description },
                    body: '',
                    render: '<div class="antidupl-card" style="padding:10px;font-size:13px;color:#888;">' +
                        '<p>' + langs.interface.no_token + '</p>' +
                        '</div>'
                });
                return;
            }

            var autoMergeStatus = settings.auto_merge
                ? langs.interface.auto_merge_status
                : langs.interface.auto_merge_disabled;

            self.render_template({
                caption: { class_name: 'antidupl-caption', html: langs.widget.short_description },
                body: '',
                render: '<div class="antidupl-card" style="padding:10px;font-size:13px;">' +
                    '<p style="margin:0 0 5px;color:#555;">' + autoMergeStatus + '</p>' +
                    '</div>'
            });
        }

        // ---------- Callbacks ----------
        this.callbacks = {
            render: function () {
                var area = system.area;
                if (area === 'ccard') {
                    if (typeof (APP.data.current_card) != 'undefined' && APP.data.current_card.id == 0) {
                        return false;
                    }
                    initCardUI();
                }
                return true;
            },

            init: function () {
                return true;
            },

            bind_actions: function () {
                return true;
            },

            settings: function ($modal_body) {
                $modal_body = $modal_body || $('.widget-settings__body').first();
                initSettingsUI();
                return true;
            },

            onSave: function (data) {
                handleAutoMerge(data);
                return true;
            },

            destroy: function () {
                return true;
            },

            contacts: { selected: function () { return true; } },
            leads: { selected: function () { return true; } },
            todo: { selected: function () { return true; } }
        };

        self.getTemplate = function (template, callback) {
            return self.render({
                href: '/templates/' + template + '.twig',
                base_path: self.params.path,
                load: callback
            }, {});
        };

        return this;
    };
    return CustomWidget;
});
