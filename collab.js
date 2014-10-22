define(function(require, exports, module) {
"use strict";

    main.consumes = [
        "Panel", "tabManager", "fs", "metadata", "ui", "apf", "settings", 
        "preferences", "ace", "util", "collab.connect", "collab.workspace", 
        "timeslider", "OTDocument", "notification.bubble", "dialog.error",
        "collab.util", "error_handler"
    ];
    main.provides = ["collab"];
    return main;

    function main(options, imports, register) {
        var Panel = imports.Panel;
        var tabs = imports.tabManager;
        var fs = imports.fs;
        var metadata = imports.metadata;
        var ui = imports.ui;
        var apf = imports.apf;
        var ace = imports.ace;
        var util = imports.util;
        var collabUtil = imports["collab.util"];
        var settings = imports.settings;
        var prefs = imports.preferences;
        var connect = imports["collab.connect"];
        var workspace = imports["collab.workspace"];
        var bubble = imports["notification.bubble"];
        var timeslider = imports.timeslider;
        var OTDocument = imports.OTDocument;
        var showError = imports["dialog.error"].show;
        var errorHandler = imports.error_handler;

        var css = require("text!./collab.css");
        var staticPrefix = options.staticPrefix;

        var plugin = new Panel("Ajax.org", main.consumes, {
            index: 45,
            width: 250,
            caption: "Collaborate",
            className: "collab",
            elementName: "winCollab",
            minWidth: 130,
            where: "right"
        });
        var emit = plugin.getEmitter();

        // open collab documents
        var documents = {};
        var openFallbackTimeouts = {};
        var saveFallbackTimeouts = {};
        var usersLeaving = {};
        var lastSaveSuccess = true;
        var OPEN_FILESYSTEM_FALLBACK_TIMEOUT = 6000;
        var SAVE_FILESYSTEM_FALLBACK_TIMEOUT = 30000;
        var SAVE_FILESYSTEM_FALLBACK_TIMEOUT_REPEATED = 15000;

        var loaded = false;
        function load() {
            if (loaded) return;
            loaded = true;

            connect.on("message", onMessage);
            connect.on("connecting", onConnecting);
            connect.on("connect", onConnectMsg);
            connect.on("disconnect", onDisconnect);

            metadata.on("beforeReadFile", beforeReadFile, plugin);
            fs.on("afterReadFile", afterReadFile, plugin);
            fs.on("beforeWriteFile", beforeWriteFile, plugin);

            ace.on("initAceSession", function(e) {
                var doc = e.doc;
                var path = doc.tab.path;
                var otDoc = documents[path];
                if (otDoc && !otDoc.session)
                    otDoc.setSession(doc.getSession().session);
            });

            tabs.on("focusSync", function(e){
                var tab = e.tab;
                var otDoc = documents[tab.path];
                if (otDoc && !otDoc.session) {
                    var doc = tab.document;
                    var docSession = doc.getSession();
                    docSession && otDoc.setSession(docSession.session);
                }
            });

            ui.insertCss(css, staticPrefix, plugin);

            window.addEventListener("unload", function() {
                leaveAll();
            }, false);
            
            tabs.on("open", function(e) {
                var tab = e.tab;
                tab.on("setPath", function(e) {
                    onSetPath(tab, e.oldpath, e.path);
                });
            });

            tabs.on("tabDestroy", function(e) {
                leaveDocument(e.tab.path);
            }, plugin);

            // Author layer settings
            var showAuthorInfoKey = "user/collab/@show-author-info";
            prefs.add({
                "General" : {
                    "Collaboration" : {
                        "Show Authorship Info" : {
                            type: "checkbox",
                            position: 8000,
                            path: showAuthorInfoKey
                        }
                    }
                }
            }, plugin);

            settings.on("read", function () {
                settings.setDefaults("user/collab", [["show-author-info", true]]);
                refreshActiveDocuments();
            }, plugin);

            settings.on("user/collab", function () {
                refreshActiveDocuments();
            }, plugin);
        }

        var drawn = false;
        function draw(options) {
            if (drawn) return;
            drawn = true;

            var bar = options.aml.appendChild(new ui.bar({
                "id"    : "winCollab",
                "skin"  : "panel-bar",
                "class" : "collab-bar"
            }));
            plugin.addElement(bar);

            var html = bar.$int;
            emit.sticky("drawPanels", { html: html, aml: bar });
        }

        function onDisconnect() {
            for (var docId in documents) {
                var doc = documents[docId];
                doc.disconnect();
            }
            // bubbleNotification("Collab disconnected");
            emit("disconnect");
        }

        function onConnecting () {
            // bubbleNotification("Collab connecting");
        }

        function onConnectMsg(msg) {
            workspace.syncWorkspace(msg.data);

            for (var docId in documents)
                documents[docId].load();

            // bubbleNotification(msg.err || "Collab connected");
            emit("connect");
        }

        function onMessage(msg) {
            var data = msg.data || {};
            var user = data && data.userId && workspace.getUser(data.userId);
            var type = msg.type;
            var docId = data.docId;
            if (docId && "/~".indexOf(docId[0]) === -1)
                docId = data.docId = "/" + docId;
            var doc = documents[docId];

            if (!connect.connected && type !== "CONNECT")
                return console.warn("[OT] Not connected - ignoring:", msg);

            if (data.clientId && data.clientId === workspace.myOldClientId)
                return console.warn("[OT] Skipping my own 'away' disconnection notifications");

            switch (type) {
                case "CHAT_MESSAGE":
                    data.increment = true;
                    emit("chatMessage", data);
                    break;
                case "USER_JOIN":
                    user = data.user;
                    if (!user)
                        break;
                    workspace.joinClient(user);
                    notifyUserOnline(user);
                    break;
                case "USER_LEAVE":
                    workspace.leaveClient(data.userId);
                    notifyUserOffline(user);
                    break;
                case "LEAVE_DOC":
                    doc && doc.clientLeave(data.clientId);
                    // bubbleNotification("closed file: " + docId, user);
                    break;
                case "JOIN_DOC":
                    if (workspace.myClientId !== data.clientId)
                        // bubbleNotification("opened file: " + docId, user);
                        return;
                    if (!doc)
                        return console.warn("[OT] Received msg for file that is not open - docId:", docId, "open docs:", Object.keys(documents));
                    doc.joinData(data);
                    break;
                case "LARGE_DOC":
                    doc && doc.leave();
                    doc && reportLargeDocument(doc, !msg.data.response);
                    delete documents[docId];
                    break;
                case "USER_STATE":
                    workspace.updateUserState(data.userId, data.state);
                    break;
                case "CLEAR_CHAT":
                    emit("chatClear", data);
                    break;
                default:
                    if (!doc)
                        return console.warn("[OT] Received msg for file that is not open", docId, msg);
                    if (doc.loaded)
                        doc.handleMessage(msg);
                    else
                        console.warn("[OT] Doc ", docId, " not yet inited - MSG:", msg);
            }
        }
        
        function notifyUserOffline(user) {
            clearTimeout(usersLeaving[user.fullname]);
            usersLeaving[user.fullname] = setTimeout(function() {
                bubbleNotification("went offline", user);
                delete usersLeaving[user.fullname];
            }, 4000);
        }
        
        function notifyUserOnline(user) {
            if (usersLeaving[user.fullname]) {
                // User left for like 4 seconds, don't notify
                clearTimeout(usersLeaving[user.fullname]);
                return;
            }
            
            bubbleNotification("came online", user);
        }

        /**
         * Join a document and report progress and on-load contents
         * @param {String} docId
         * @param {Document} doc
         * @param {Function} [progress]
         */
        function joinDocument(docId, doc, progress) {
            console.log("[OT] Join", docId);
            var docSession = doc.getSession();
            var aceSession = docSession && docSession.session;
            if (!aceSession)
                console.warn("[OT] Ace session not ready for:", docId, "- will setSession when ready!");

            var otDoc = documents[docId] || new OTDocument(docId, doc);

            if (aceSession)
                otDoc.setSession(aceSession);

            if (progress)
                setupProgressCallback(otDoc, progress);

            if (documents[docId])
                return console.warn("[OT] Document previously joined -", docId,
                "STATE: loading:", otDoc.loading, "loaded:", otDoc.loaded, "inited:", otDoc.inited);

            documents[docId] = otDoc;

            // test late join - document syncing - best effort
            if (connect.connected)
                otDoc.load();

            return otDoc;
        }

        function setupProgressCallback(otDoc, progress) {
            otDoc.on("joinProgress", function(e) {
                progress && progress(e.loaded, e.total, e.complete);
            });
        }

        function leaveDocument(docId) {
            if (!docId || !documents[docId] || !connect.connected)
                return;
            console.log("[OT] Leave", docId);
            var doc = documents[docId];
            doc.leave(); // will also dispose
            delete documents[docId];
        }
        
        function reportLargeDocument(doc, forceReadonly) {
            var docId = doc.id;
            if (workspace.isAdmin && !forceReadonly) {
                if (workspace.onlineCount === 1)
                    return console.log("File is very large, collaborative editing disabled: " + docId);
                return showError("File is very large, collaborative editing disabled: " + docId, 5000);
            }
            showError("File is very large. Collaborative editing disabled: " + docId, 5000);
            var tab = tabs.findTab(docId);
            if (!tab || !tab.editor)
                return;
            tab.classList.add("error");
            if (doc.readonly)
                return;
            doc.readonly = true;
        }

        function saveDocument(docId, fallbackFn, fallbackArgs, callback) {
            var doc = documents[docId];
            var joinError;
            clearTimeout(saveFallbackTimeouts[docId]);

            saveFallbackTimeouts[docId] = setTimeout(function() {
                console.warn("[OT] collab saveFallbackTimeout while trying to save file", docId, "- trying fallback approach instead");
                fsSaveFallback();
                doc.off("saved", onSaved);
                lastSaveSuccess = false;
            }, lastSaveSuccess ? SAVE_FILESYSTEM_FALLBACK_TIMEOUT : SAVE_FILESYSTEM_FALLBACK_TIMEOUT_REPEATED);

            function onSaved(e) {
                doc.off("saved", onSaved);
                clearTimeout(saveFallbackTimeouts[docId]);
                if ((e.code == "ETIMEOUT" || e.code == "EMISMATCH") && fallbackFn) {
                    // The vfs socket is probably dead ot stale
                    console.warn("[OT] collab error:", e.code, "trying to save file", docId, "- trying fallback approach instead");
                    return fsSaveFallback({ code: e.code, err: e.err });
                }
                lastSaveSuccess = !e.err;
                callback(e.err);
            }

            function fsSaveFallback(attempt) {
                var message = doc && doc.loaded
                    ? "Warning: using fallback saving on loaded document"
                    : "Warning: using fallback saving on unloaded document";
                errorHandler.reportError(new Error(message), {
                    docId: docId,
                    loading: doc && doc.loading,
                    loaded: doc && doc.loaded,
                    inited: doc && doc.inited,
                    rejoinReason: doc && doc.rejoinReason,
                    state: doc && doc.state,
                    joinError: joinError,
                    connected: connect.connected,
                    attempt: attempt
                }, ["collab"]);
                
                fallbackFn.apply(null, fallbackArgs);
            }

            if (!doc.loaded || !connect.connected) {
                doc.once("joined", function(e) {
                    joinError = e && e.err;
                    if (e && !e.err)
                        doCollabSave();
                });
            }
            else {
                doCollabSave();
            }

            function doCollabSave() {
                doc.on("saved", onSaved);
                doc.save();
            }
        }

        function leaveAll() {
            Object.keys(documents).forEach(function(docId) {
                leaveDocument(docId);
            });
        }

        function refreshActiveDocuments() {
            for (var docId in documents) {
                var doc = documents[docId];
                var tab = doc.original.tab;
                if (tab.pane.activeTab === tab && doc.inited)
                    doc.authorLayer.refresh();
            }
        }

        /*
        function getDocumentsWithinPath(path) {
            var docIds = Object.keys(documents);
            var docs = [];
            for (var i = 0, l = docIds.length; i < l; ++i) {
                var doc = documents[docIds[i]];
                if (doc.id.indexOf(path) === 0)
                    docs.push(doc);
            }
            return docs;
        };
        */

        /**
         * Start a Collab session with each metadata read.
         *
         * e.path
         * e.tab
         * e.callback
         * e.progress
         */
        function beforeReadFile(e) {
            var path = e.path;
            var progress = e.progress;
            var callback = e.callback;
            var otDoc = documents[path];
            if (!otDoc)
                otDoc = documents[path] = joinDocument(path, e.tab.document, progress);
            else
                setupProgressCallback(otDoc, progress);

            otDoc.on("joined", onJoined);
            otDoc.on("largeDocument", reportLargeDocument.bind(null, otDoc) );
            otDoc.on("joinProgress", startWatchDog);

            // Load using XHR while collab not connected
            if (!connect.connected)
                return;
            
            startWatchDog();

            var fallbackXhrAbort;
            return {
                abort: function() {
                    if (fallbackXhrAbort)
                        fallbackXhrAbort();
                    else
                        console.log("TODO: [OT] abort joining a document");
                }   
            };

            function startWatchDog() {
                clearTimeout(openFallbackTimeouts[path]);
                openFallbackTimeouts[path] = setTimeout(function() {
                    console.warn("[OT] JOIN_DOC timed out:", path, "- fallback to filesystem, but don't abort");
                    fsOpenFallback();
                    otDoc.off("joined", onJoined);
                }, OPEN_FILESYSTEM_FALLBACK_TIMEOUT);
            }

            function onJoined(e) {
                otDoc.off("joined", onJoined);
                clearTimeout(openFallbackTimeouts[path]);
                openFallbackTimeouts[path] = null;
                if (e.err) {
                    if (e.err.code != "ENOENT" && e.err.code != "ELARGE")
                        console.warn("[OT] JOIN_DOC failed:", path, "- fallback to filesystem");
                    return fsOpenFallback();
                }
                console.log("[OT] Joined", otDoc.id);
                callback(e.err, e.contents, e.metadata);
            }

            function fsOpenFallback() {
                var xhr = fs.readFileWithMetadata(path, "utf8", callback, progress) || {};
                fallbackXhrAbort = ((xhr && xhr.abort) || function(){}).bind(xhr);
            }
        }

        /**
         * Normalize tab contents after file read.
         */
        function afterReadFile(e) {
            var path = e.path;
            var tab = tabs.findTab(path);
            var doc = documents[path];
            if (!tab || !doc || doc.loaded)
                return;
            var httpLoadedValue = tab.document.value;
            var normHttpValue = collabUtil.normalizeTextLT(httpLoadedValue);
            if (httpLoadedValue !== normHttpValue)
                tab.document.value = normHttpValue;
        }

        /**
         * Save using collab server for OT-enabled documents.
         * Overrides the normal file writing behavior.
         */
        function beforeWriteFile(e) {
            var path = e.path;
            var tab = tabs.findTab(path);
            var doc = documents[path];

            // Fall back to default writeFile if not applicable
            if (!doc || !tab)
                return;
            if (timeslider.visible)
                return false;

            // Override default writeFile
            var args = e.args.slice();
            var progress = args.pop();
            var callback = args.pop();
            var defaultWriteFile = e.fn;
            saveDocument(path, defaultWriteFile, e.args, callback);
            return false;
        }

        function onSetPath(tab, oldpath, path) {
            console.log("[OT] detected rename/save as from", oldpath, "to", path);
            leaveDocument(oldpath);
            joinDocument(path, tab.document);
        }

        function bubbleNotification(msg, user) {
            if (!user)
                return bubble.popup(msg);

            var chatName = apf.escapeXML(user.fullname);
            var md5Email = user.email && apf.crypto.MD5.hex_md5(user.email.trim().toLowerCase());
            var defaultImgUrl = encodeURIComponent("https://www.aiga.org/uploadedImages/AIGA/Content/About_AIGA/Become_a_member/generic_avatar_300.gif");
            console.log("Collab:", user.fullname, msg);
            bubble.popup('<img width=26 height=26 class="gravatar-image" src="https://secure.gravatar.com/avatar/' +
                md5Email + '?s=26&d='  + defaultImgUrl + '" /><span>' +
                chatName + '<span class="notification_sub">' + msg + '</span></span>');
        }

        /***** Lifecycle *****/
        plugin.on("newListener", function(event, listener) {
            if (event == "connect" && connect.connected)
                listener();
        });
        plugin.on("load", function(){
            load();
        });
        plugin.on("draw", function(e) {
            draw(e);
        });
        plugin.on("unload", function(){
            loaded = false;
            drawn = true;
        });

        /**
         * @singleton
         */
        plugin.freezePublicAPI({
            _events: [
                /**
                 * Fires when the collab panel is first drawn to enable sub-collab-panels to listen and render correctly
                 * @event drawPanels
                 * @param {Object}   e
                 * @param {HTMLElement}   e.html  the html element to build collan panels on top of
                 * @param {AMLElement}    e.aml   the apf element to build collan panels on top of
                 */
                "drawPanels",
                /**
                 * Fires when the collab is connected and the collab workspace is synced
                 * @event connect
                 */
                "connect",
                /**
                 * Fires when a chat message arrives (the chat plugin should listen to it to get chat messages)
                 * @event chatMessage
                 * @param {Object}   e
                 * @param {String}   e.userId     the chat message author user id
                 * @param {String}   e.text       the chat text to diaplay
                 * @param {Boolean}  e.increment  should the chat counter be incremented (not yet implemented)
                 */
                "chatMessage",
            ],
            /**
             * Get a clone of open collab documents
             * @property {Object} documents
             */
            get documents() { return util.cloneObject(documents); },
            /**
             * Specifies whether the collab is connected or not
             * @property {Boolean} connected
             */
            get connected() { return connect.connected; },
            /**
             * Specifies whether the collab debug is enabled or not
             * @property {Boolean} debug
             */
            get debug()     { return connect.debug; },
            /**
             * Get the open collab document with path
             * @param  {String}     path the file path of the document
             * @return {OTDocument} the collab document open with this path
             */
            getDocument: function (path) { return documents[path]; },
            /**
             * Send a message to the collab server
             * @param  {String}     type    the type of the message
             * @param  {Object}     message the message body to send
             */
            send: function(type, message) { connect.send(type, message); }
        });

        register(null, {
            "collab": plugin
        });
    }
});
