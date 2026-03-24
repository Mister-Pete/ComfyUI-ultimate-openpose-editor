// Use new ComfyUI API directly to avoid deprecation issues
const app = window.comfyAPI?.app?.app;
const ComfyDialog = window.comfyAPI?.ui?.ComfyDialog;
const $el = window.comfyAPI?.ui?.$el;
const ComfyApp = window.comfyAPI?.app?.ComfyApp;

// Fallback for older versions
if (!app || !ComfyDialog || !$el || !ComfyApp) {
    console.error('[OpenposeEditor] ComfyUI API not available, extension disabled');
}


function addMenuHandler(nodeType, cb) {
    const getOpts = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function () {
        const r = getOpts.apply(this, arguments);
        cb.apply(this, arguments);
        return r;
    };
}

class OpenposeEditorDialog extends ComfyDialog {
    static timeout = 5000;
    static instance = null;

    static getInstance() {
        if (!OpenposeEditorDialog.instance) {
            OpenposeEditorDialog.instance = new OpenposeEditorDialog();
        }

        return OpenposeEditorDialog.instance;
    }

    constructor() {
        super();
        this.element = $el("div.comfy-modal", {
            parent: document.body,
            style: {
                width: "80vw",
                height: "80vh",
            },
        }, [
            $el("div.comfy-modal-content", {
                style: {
                    width: "100%",
                    height: "100%",
                },
            }, this.createButtons()),
        ]);
        this.is_layout_created = false;

        window.addEventListener("message", (event) => {
            if (!this.iframeElement || event.source !== this.iframeElement.contentWindow) {
                return;
            }

            const message = event.data;
            if (message.modalId === 0) {
                const targetNode = ComfyApp.clipspace_return_node;
                const poseWidget = this.findPoseJSONWidget(targetNode);
                const poseValue = JSON.stringify(event.data.poses);

                if (poseWidget?.element) {
                    poseWidget.element.value = poseValue;
                }
                if (poseWidget) {
                    poseWidget.value = poseValue;
                    if (typeof poseWidget.callback === "function") {
                        poseWidget.callback(poseValue, app.canvas, targetNode);
                    }
                }

                if (typeof ComfyApp.onClipspaceEditorClosed === "function") {
                    ComfyApp.onClipspaceEditorClosed();
                }
                this.close();
            }
        });
    }

    findPoseJSONWidget(targetNode) {
        const widgets = targetNode?.widgets || [];

        const byName = widgets.find((widget) =>
            typeof widget?.name === "string" &&
            /pose_json/i.test(widget.name) &&
            widget.element
        );
        if (byName) {
            return byName;
        }

        const byTextarea = widgets.find((widget) => {
            const tagName = widget?.element?.tagName;
            return tagName === "TEXTAREA";
        });
        if (byTextarea) {
            return byTextarea;
        }

        return widgets.find((widget) => widget?.element && typeof widget?.value === "string") || null;
    }

    getResolutionX(targetNode) {
        const widgets = targetNode?.widgets || [];
        const byName = widgets.find((widget) =>
            typeof widget?.name === "string" &&
            /resolution_x/i.test(widget.name)
        );

        const rawValue = byName?.value;
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) {
            return parsed;
        }

        return 512;
    }

    buildDefaultPose(targetNode) {
        let resolutionX = this.getResolutionX(targetNode);
        let resolutionY = Math.floor(768 * (resolutionX / 512));

        if (resolutionX < 64) {
            resolutionX = 512;
            resolutionY = 768;
        }

        return [{
            people: [{
                pose_keypoints_2d: [],
                face_keypoints_2d: [],
                hand_left_keypoints_2d: [],
                hand_right_keypoints_2d: [],
            }],
            canvas_height: resolutionY,
            canvas_width: resolutionX,
        }];
    }

    parsePoseJSONString(jsonString, targetNode) {
        if (!jsonString || typeof jsonString !== "string" || jsonString.trim() === "") {
            return this.buildDefaultPose(targetNode);
        }

        try {
            return JSON.parse(jsonString.replace(/'/g, '"'));
        } catch (error) {
            console.warn("[OpenposeEditor] Failed to parse POSE_JSON, using default pose.", error);
            return this.buildDefaultPose(targetNode);
        }
    }

    createButtons() {
        const closeBtn = $el("button", {
            type: "button",
            textContent: "Close",
            onclick: () => this.close(),
        });
        return [
            closeBtn,
        ];
    }

    close() {
        super.close();
    }

    async show() {
        if (!this.is_layout_created) {
            this.createLayout();
            this.is_layout_created = true;
            await this.waitIframeReady();
        }

        const targetNode = ComfyApp.clipspace_return_node;
        const poseWidget = this.findPoseJSONWidget(targetNode);
        const poseString = poseWidget?.element?.value ?? poseWidget?.value ?? "";

        this.element.style.display = "flex";
        this.setCanvasJSON(this.parsePoseJSONString(poseString, targetNode));
    }

    createLayout() {
        this.iframeElement = $el("iframe", {
            // Change to for local dev
            src: "extensions/ComfyUI-ultimate-openpose-editor/ui/OpenposeEditor.html",
            style: {
                width: "100%",
                height: "100%",
                border: "none",
            },
        });
        const modalContent = this.element.querySelector(".comfy-modal-content");
        while (modalContent.firstChild) {
            modalContent.removeChild(modalContent.firstChild);
        }
        modalContent.appendChild(this.iframeElement);
    }

    waitIframeReady() {
        return new Promise((resolve, reject) => {
            const receiveMessage =  (event) => {
                if (event.source !== this.iframeElement.contentWindow) {
                    return;
                }
                if (event.data.ready) {
                    window.removeEventListener("message", receiveMessage);
                    clearTimeout(timeoutHandle);
                    resolve();
                }
            };
            const timeoutHandle = setTimeout(() => {
                reject(new Error("Timeout"));
            }, OpenposeEditorDialog.timeout);

            window.addEventListener("message", receiveMessage);
        });
    }

    setCanvasJSON(poses) {
        if (!this.iframeElement?.contentWindow) {
            return;
        }

        this.iframeElement.contentWindow.postMessage({
            modalId: 0,
            poses,
        }, "*");
    }
}

// Only register if API is available
if (app && ComfyDialog && $el && ComfyApp) {
    app.registerExtension({
        name: "OpenposeEditor",

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name === "OpenposeEditorNode") {
                addMenuHandler(nodeType, function (_, options) {
                    options.unshift({
                        content: "Open in Openpose Editor",
                        callback: () => {
                            // `this` is the node instance
                            ComfyApp.copyToClipspace(this);
                            ComfyApp.clipspace_return_node = this;

                            const dlg = OpenposeEditorDialog.getInstance();
                            dlg.show();
                        },
                    });
                });
            }
        }
    });
}
