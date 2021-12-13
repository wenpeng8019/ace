/* ***** BEGIN LICENSE BLOCK *****
 * Distributed under the BSD license:
 *
 * Copyright (c) 2010, Ajax.org B.V.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * Neither the name of Ajax.org B.V. nor the
 *       names of its contributors may be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL AJAX.ORG B.V. BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * ***** END LICENSE BLOCK ***** */

define(function(require, exports, module) {
"use strict";

var event = require("../lib/event");
var useragent = require("../lib/useragent");
var dom = require("../lib/dom");
var lang = require("../lib/lang");
var clipboard = require("../clipboard");
var BROKEN_SETDATA = useragent.isChrome < 18;
var USE_IE_MIME_TYPE =  useragent.isIE;
var HAS_FOCUS_ARGS = useragent.isChrome > 63;
var MAX_LINE_LENGTH = 400;

var KEYS = require("../lib/keys");
var MODS = KEYS.KEY_MODS;
var isIOS = useragent.isIOS;
var valueResetRegex = isIOS ? /\s/ : /\n/;
var isMobile = useragent.isMobile;

// 定义 TextInput 类
// + 从架构上看，TextInput 类是个单例模型。
//   因此，这里对于 TextInput 类成员函数的定义，并没有 TextInput.prototype（原型）模式
var TextInput = function(parentNode, host/* :Editor */) {
    // @ editor.js
    // + 关于 this 指针
    //   指向 new TextInput() 对象

    // 创建 <Textarea> 元素作为 input 对象 
    var text = dom.createElement("textarea");
    text.className = "ace_text-input";

    // 修改 <Textarea> 元素的默认属性设定
    text.setAttribute("wrap", "off");
    text.setAttribute("autocorrect", "off");
    text.setAttribute("autocapitalize", "off");
    text.setAttribute("spellcheck", false);

    // 设置 <Textarea> 元素为透明
    text.style.opacity = "0";
    parentNode.insertBefore(text, parentNode.firstChild);

    var copied = false;
    var pasted = false;
    // 是否处于输入（法）合成会话状态
    // + 有效值定义：false | true | Options:{ useTextareaForIME; markerRange; selectionStart; context; }
    var inComposition = false;
    var sendingText = false;
    var tempStyle = '';
    
    if (!isMobile)
        text.style.fontSize = "1px";

    var commandMode = false;
    var ignoreFocusEvents = false;
    
    var lastValue = "";
    var lastSelectionStart = 0;
    var lastSelectionEnd = 0;
    var lastRestoreEnd = 0;
    
    ///////////////////////////////////////////////////////////////////////////
    // 输入焦点处理
    ///////////////////////////////////////////////////////////////////////////

    // FOCUS
    // ie9 throws error if document.activeElement is accessed too soon
    try { var isFocused = document.activeElement === text; } catch(e) {}
    
    event.addListener(text, "blur", function(e) {
        if (ignoreFocusEvents) return;
        host.onBlur(e);
        isFocused = false;
    }, host);

    event.addListener(text, "focus", function(e) {
        if (ignoreFocusEvents) return;
        isFocused = true;
        if (useragent.isEdge) {
            // on edge focus event is fired even if document itself is not focused
            try {
                if (!document.hasFocus())
                    return;
            } catch(e) {}
        }
        host.onFocus(e);
        if (useragent.isEdge)
            setTimeout(resetSelection);
        else
            resetSelection();
    }, host);
    
    this.$focusScroll = false;
    this.focus = function() {
        if (tempStyle || HAS_FOCUS_ARGS || this.$focusScroll == "browser")
            return text.focus({ preventScroll: true });

        var top = text.style.top;
        text.style.position = "fixed";
        text.style.top = "0px";
        try {
            var isTransformed = text.getBoundingClientRect().top != 0;
        } catch(e) {
            // getBoundingClientRect on IE throws error if element is not in the dom tree
            return;
        }
        var ancestors = [];
        if (isTransformed) {
            var t = text.parentElement;
            while (t && t.nodeType == 1) {
                ancestors.push(t);
                t.setAttribute("ace_nocontext", true);
                if (!t.parentElement && t.getRootNode)
                    t = t.getRootNode().host;
                else
                    t = t.parentElement;
            }
        }
        text.focus({ preventScroll: true });
        if (isTransformed) {
            ancestors.forEach(function(p) {
                p.removeAttribute("ace_nocontext");
            });
        }
        setTimeout(function() {
            text.style.position = "";
            if (text.style.top == "0px")
                text.style.top = top;
        }, 0);
    };
    this.blur = function() {
        text.blur();
    };
    this.isFocused = function() {
        return isFocused;
    };
    
    ///////////////////////////////////////////////////////////////////////////

    host.on("beforeEndOperation", function() {
        var curOp = host.curOp;
        var commandName = curOp && curOp.command && curOp.command.name;
        if (commandName == "insertstring")
            return;
        var isUserAction = commandName && (curOp.docChanged || curOp.selectionChanged);
        if (inComposition && isUserAction) {
            // exit composition from commands other than insertstring
            lastValue = text.value = "";
            onCompositionEnd();
        }
        // sync value of textarea
        resetSelection();
    });
    
    ///////////////////////////////////////////////////////////////////////////

    var resetSelection = isIOS
    ? function(value) {
        if (!isFocused || (copied && !value) || sendingText) return;
        if (!value) 
            value = "";
        var newValue = "\n ab" + value + "cde fg\n";
        if (newValue != text.value)
            text.value = lastValue = newValue;
        
        var selectionStart = 4;
        var selectionEnd = 4 + (value.length || (host.selection.isEmpty() ? 0 : 1));

        if (lastSelectionStart != selectionStart || lastSelectionEnd != selectionEnd) {
            text.setSelectionRange(selectionStart, selectionEnd);
        }
        lastSelectionStart = selectionStart;
        lastSelectionEnd = selectionEnd;
    }
    : function() {
        if (inComposition || sendingText)
            return;
        // modifying selection of blured textarea can focus it (chrome mac/linux)
        if (!isFocused && !afterContextMenu)
            return;
        // this prevents infinite recursion on safari 8 
        // see https://github.com/ajaxorg/ace/issues/2114
        inComposition = true;
        
        var selectionStart = 0;
        var selectionEnd = 0;
        var line = "";

        if (host.session) {
            var selection = host.selection;
            var range = selection.getRange();
            var row = selection.cursor.row;
            selectionStart = range.start.column;
            selectionEnd = range.end.column;
            line = host.session.getLine(row);

            if (range.start.row != row) {
                var prevLine = host.session.getLine(row - 1);
                selectionStart = range.start.row < row - 1 ? 0 : selectionStart;
                selectionEnd += prevLine.length + 1;
                line = prevLine + "\n" + line;
            }
            else if (range.end.row != row) {
                var nextLine = host.session.getLine(row + 1);
                selectionEnd = range.end.row > row  + 1 ? nextLine.length : selectionEnd;
                selectionEnd += line.length + 1;
                line = line + "\n" + nextLine;
            }
            else if (isMobile && row > 0) {
                line = "\n" + line;
                selectionEnd += 1;
                selectionStart += 1;
            }

            if (line.length > MAX_LINE_LENGTH) {
                if (selectionStart < MAX_LINE_LENGTH && selectionEnd < MAX_LINE_LENGTH) {
                    line = line.slice(0, MAX_LINE_LENGTH);
                } else {
                    line = "\n";
                    if (selectionStart == selectionEnd) {
                        selectionStart = selectionEnd = 0;
                    }
                    else {
                        selectionStart = 0;
                        selectionEnd = 1;
                    }
                }
            }
        }

        var newValue = line + "\n\n";
        if (newValue != lastValue) {
            text.value = lastValue = newValue;
            lastSelectionStart = lastSelectionEnd = newValue.length;
        }
        
        // contextmenu on mac may change the selection
        if (afterContextMenu) {
            lastSelectionStart = text.selectionStart;
            lastSelectionEnd = text.selectionEnd;
        }
        // on firefox this throws if textarea is hidden
        if (
            lastSelectionEnd != selectionEnd 
            || lastSelectionStart != selectionStart 
            || text.selectionEnd != lastSelectionEnd // on ie edge selectionEnd changes silently after the initialization
        ) {
            try {
                text.setSelectionRange(selectionStart, selectionEnd);
                lastSelectionStart = selectionStart;
                lastSelectionEnd = selectionEnd;
            } catch(e){}
        }
        inComposition = false;
    };
    this.resetSelection = resetSelection;

    ///////////////////////////////////////////////////////////////////////////

    if (isFocused)
        host.onFocus();


    var isAllSelected = function(text) {
        return text.selectionStart === 0 && text.selectionEnd >= lastValue.length
            && text.value === lastValue && lastValue
            && text.selectionEnd !== lastSelectionEnd;
    };

    var onSelect = function(e) {
        if (inComposition)
            return;
        if (copied) {
            copied = false;
        } else if (isAllSelected(text)) {
            host.selectAll();
            resetSelection();
        } else if (isMobile && text.selectionStart != lastSelectionStart) {
            resetSelection();
        }
    };

    var inputHandler = null;
    this.setInputHandler = function(cb) {inputHandler = cb;};
    this.getInputHandler = function() {return inputHandler;};
    var afterContextMenu = false;
    
    var sendText = function(value, fromInput) {

        if (afterContextMenu)
            afterContextMenu = false;

        if (pasted) {

            resetSelection();

            if (value)
                host.onPaste(value);

            pasted = false;
            
            return "";

        } else {

            // 计算本次输入，和上次输入之间的差异

            var selectionStart = text.selectionStart;
            var selectionEnd = text.selectionEnd;
        
            var extendLeft = lastSelectionStart;
            var extendRight = lastValue.length - lastSelectionEnd;
            
            var inserted = value;
            var restoreStart = value.length - selectionStart;
            var restoreEnd = value.length - selectionEnd;
        
            var i = 0;
            while (extendLeft > 0 && lastValue[i] == value[i]) {
                i++;
                extendLeft--;
            }
            inserted = inserted.slice(i);

            i = 1;
            while (extendRight > 0 && lastValue.length - i > lastSelectionStart - 1  && lastValue[lastValue.length - i] == value[value.length - i]) {
                i++;
                extendRight--;
            }
            restoreStart -= i-1;
            restoreEnd -= i-1;
            var endIndex = inserted.length - i + 1;
            if (endIndex < 0) {
                extendLeft = -endIndex;
                endIndex = 0;
            } 
            inserted = inserted.slice(0, endIndex);
            
            // composition update can be called without any change
            // 如果本次输入和上次输入没有差异
            if (!fromInput && !inserted && !restoreStart && !extendLeft && !extendRight && !restoreEnd)
                return "";

            sendingText = true;
            
            // some android keyboards converts two spaces into sentence end, which is not useful for code
            // 有些输入法（Android）会将两个空格自动替换为句号。这里觉得没必要，将这种自动替换的机制取消了
            var shouldReset = false;
            if (useragent.isAndroid && inserted == ". ") {
                inserted = "  ";
                shouldReset = true;
            }
            
            if (inserted && !extendLeft && !extendRight && !restoreStart && !restoreEnd || commandMode) {
                host.onTextInput(inserted);
            } else {
                host.onTextInput(inserted, {
                    extendLeft: extendLeft,
                    extendRight: extendRight,
                    restoreStart: restoreStart,
                    restoreEnd: restoreEnd
                });
            }

            sendingText = false;
            
            // 记录最后一次（输入）文本后的（选择区域）状态
            lastValue = value;
            lastSelectionStart = selectionStart;
            lastSelectionEnd = selectionEnd;
            lastRestoreEnd = restoreEnd;

            return shouldReset ? "\n" : inserted;
        }
    };

    ///////////////////////////////////////////////////////////////////////////

    var onInput = function(e) {

        // 如果处于 "输入合成" 会话状态（即处于输入法输入过程中）
        if (inComposition)
            return onCompositionUpdate();

        // 如果输入的是系统快捷键
        if (e && e.inputType) {
            if (e.inputType == "historyUndo") return host.execCommand("undo");
            if (e.inputType == "historyRedo") return host.execCommand("redo");
        }

        // 获取输入文本
        // + 这里将 <Textarea> 的（全部）内容作为实际输入内容
        var data = text.value;
        var inserted = sendText(data, true);

        //（如果需要）同步更新 <Textarea>（作为缓冲区）中的数据
        // - 如果缓存区中输入的数据超出上限
        // - 缓存区中的数据出现了语义分段
        //   + 目前的逻辑是：对于移动端，输入了空格；否则，输入了换行符
        // - (对于移动端) 输入导致 caret 位于 <Textarea> 首位位置
        //   + 一个典型的场景就是输入的是 DEL 字符，导致将 <Textarea> 的首部（n 个字符）删除
        if (
            data.length > MAX_LINE_LENGTH + 100 
            || valueResetRegex.test(inserted)
            || isMobile && lastSelectionStart < 1 && lastSelectionStart == lastSelectionEnd
        ) {
            resetSelection();
        }
    };
    
    var handleClipboardData = function(e, data, forceIEMime) {
        var clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData || BROKEN_SETDATA)
            return;
        // using "Text" doesn't work on old webkit but ie needs it
        var mime = USE_IE_MIME_TYPE || forceIEMime ? "Text" : "text/plain";
        try {
            if (data) {
                // Safari 5 has clipboardData object, but does not handle setData()
                return clipboardData.setData(mime, data) !== false;
            } else {
                return clipboardData.getData(mime);
            }
        } catch(e) {
            if (!forceIEMime)
                return handleClipboardData(e, data, true);
        }
    };

    var doCopy = function(e, isCut) {
        var data = host.getCopyText();
        if (!data)
            return event.preventDefault(e);

        if (handleClipboardData(e, data)) {
            if (isIOS) {
                resetSelection(data);
                copied = data;
                setTimeout(function () {
                    copied = false;
                }, 10);
            }
            isCut ? host.onCut() : host.onCopy();
            event.preventDefault(e);
        } else {
            copied = true;
            text.value = data;
            text.select();
            setTimeout(function(){
                copied = false;
                resetSelection();
                isCut ? host.onCut() : host.onCopy();
            });
        }
    };
    
    var onCut = function(e) {
        doCopy(e, true);
    };
    
    var onCopy = function(e) {
        doCopy(e, false);
    };
    
    var onPaste = function(e) {
        var data = handleClipboardData(e);
        if (clipboard.pasteCancelled())
            return;
        if (typeof data == "string") {
            if (data)
                host.onPaste(data, e);
            if (useragent.isIE)
                setTimeout(resetSelection);
            event.preventDefault(e);
        }
        else {
            text.value = "";
            pasted = true;
        }
    };

    // 这里实际上是监听了 'keydown'、'keyup'、'keypress' 三个键盘事件
    // + 然后将这些键盘事件，优先作为命令进行解析
    //   对于解析出来的命令操作，会触发 editor 的 `onCommandKey` 进行处理
    // + 这些命令包括了各种文本编辑器的基本操作和快捷命令操作，最基本的如：方向键移动 caret 等
    event.addCommandKeyListener(text, host.onCommandKey.bind(host), host);

    event.addListener(text, "select", onSelect, host);
    event.addListener(text, "input", onInput, host);

    event.addListener(text, "cut", onCut, host);
    event.addListener(text, "copy", onCopy, host);
    event.addListener(text, "paste", onPaste, host);


    // Opera has no clipboard events
    if (!('oncut' in text) || !('oncopy' in text) || !('onpaste' in text)) {
        event.addListener(parentNode, "keydown", function(e) {
            if ((useragent.isMac && !e.metaKey) || !e.ctrlKey)
                return;

            switch (e.keyCode) {
                case 67:
                    onCopy(e);
                    break;
                case 86:
                    onPaste(e);
                    break;
                case 88:
                    onCut(e);
                    break;
            }
        }, host);
    }

    ///////////////////////////////////////////////////////////////////////////
    // 输入（法）合成会话处理
    ///////////////////////////////////////////////////////////////////////////

    // COMPOSITION
    var onCompositionStart = function(e/* DOM::InputEvent */) {

        // 验证允许启动输入（法）合成会话的条件
        if (inComposition || !host.onCompositionStart || host.$readOnly) 
            return;
        
        // 启动 Composition 会话，并初始化 Composition 会话选项为空            
        inComposition = {};

        //（用于支持 vim 的）`command` 模式会禁止对该事件的默认处理
        if (commandMode)
            return;
        
        if (e.data)
            inComposition.useTextareaForIME = false;

        // 随后（异步）执行 onCompositionUpdate 处理
        setTimeout(onCompositionUpdate, 0);

        host._signal("compositionStart");
        host.on("mousedown", cancelComposition);
        
        // 初始化 Composition 会话默认选项
        var range = host.getSelectionRange();
        range.end.row = range.start.row;
        range.end.column = range.start.column;
        inComposition.markerRange = range;
        inComposition.selectionStart = lastSelectionStart;

        host.onCompositionStart(inComposition);

        // 如果 "将 textarea 作为 IME 处理器"
        // + 清除 text 中（之前）缓存的文本
        if (inComposition.useTextareaForIME) {
            lastValue = text.value = "";
            lastSelectionStart = 0;
            lastSelectionEnd = 0;
        }
        else {
            if (text.msGetInputContext)
                inComposition.context = text.msGetInputContext();
            if (text.getInputContext)
                inComposition.context = text.getInputContext();
        }
    };

    var onCompositionUpdate = function() {

        // 验证处于输入（法）合成会话的条件
        if (!inComposition || !host.onCompositionUpdate || host.$readOnly)
            return;

        //（用于支持 vim 的）`command` 模式会禁止对该事件的默认处理
        if (commandMode)
            return cancelComposition();
        
        // 如果 "将 textarea 作为 IME 处理器"
        // + 此时向 editor（模拟）触发 onCompositionUpdate 事件
        if (inComposition.useTextareaForIME) {
            host.onCompositionUpdate(text.value);
        }
        // 否则将 IME 输入的数据，直接作为输入文本
        // + 此时直接向 editor（模拟）触发 input 事件
        else {
            var data = text.value;
            sendText(data);
            if (inComposition.markerRange) {
                if (inComposition.context) {
                    inComposition.markerRange.start.column = inComposition.selectionStart
                        = inComposition.context.compositionStartOffset;
                }
                inComposition.markerRange.end.column = inComposition.markerRange.start.column
                    + lastSelectionEnd - inComposition.selectionStart + lastRestoreEnd;
            }
        }
    };

    var onCompositionEnd = function(e) {

        if (!host.onCompositionEnd || host.$readOnly) return;

        // 结束 Composition 会话，并清除 Composition 选项
        inComposition = false;

        host.onCompositionEnd();
        host.off("mousedown", cancelComposition);

        // note that resetting value of textarea at this point doesn't always work
        // because textarea value can be silently restored
        if (e) onInput();
    };
    

    function cancelComposition() {

        // 通过输入焦点重入的方式来取消 Composition 会话
        // force end composition
        ignoreFocusEvents = true;
        text.blur();
        text.focus();
        ignoreFocusEvents = false;
    }

    // 创建 onCompositionUpdate 的延迟执行对象
    // + 这里 syncComposition 是一个对象，是在 onCompositionUpdate 功能的基础上，增加了延迟执行的机制
    //   syncComposition 对象本身也是一个函数，其自身的执行用于启动延迟调用
    var syncComposition = lang.delayedCall(onCompositionUpdate, 50).schedule.bind(null, null);
    
    function onKeyup(e) {

        // workaround for a bug in ie where pressing esc silently moves selection out of textarea
        if (e.keyCode == 27/* ESC */ && text.value.length < text.selectionStart) {
            if (!inComposition)
                lastValue = text.value;
            lastSelectionStart = lastSelectionEnd = -1;
            resetSelection();
        }

        syncComposition();
    }

    event.addListener(text, "compositionstart", onCompositionStart, host);
    event.addListener(text, "compositionupdate", onCompositionUpdate, host);
    event.addListener(text, "keyup", onKeyup, host);
    event.addListener(text, "keydown", syncComposition, host);
    event.addListener(text, "compositionend", onCompositionEnd, host);

    ///////////////////////////////////////////////////////////////////////////

    this.getElement = function() {
        return text;
    };
    
    // allows to ignore composition (used by vim keyboard handler in the normal mode)
    // this is useful on mac, where with some keyboard layouts (e.g swedish) ^ starts composition
    this.setCommandMode = function(value) {
       commandMode = value;
       text.readOnly = false;
    };
    
    this.setReadOnly = function(readOnly) {
        if (!commandMode)
            text.readOnly = readOnly;
    };

    this.setCopyWithEmptySelection = function(value) {
    };

    ///////////////////////////////////////////////////////////////////////////

    this.onContextMenu = function(e) {
        afterContextMenu = true;
        resetSelection();
        host._emit("nativecontextmenu", {target: host, domEvent: e});
        this.moveToMouse(e, true);
    };
    
    this.moveToMouse = function(e, bringToFront) {
        if (!tempStyle)
            tempStyle = text.style.cssText;
        text.style.cssText = (bringToFront ? "z-index:100000;" : "")
            + (useragent.isIE ? "opacity:0.1;" : "")
            + "text-indent: -" + (lastSelectionStart + lastSelectionEnd) * host.renderer.characterWidth * 0.5 + "px;";

        var rect = host.container.getBoundingClientRect();
        var style = dom.computedStyle(host.container);
        var top = rect.top + (parseInt(style.borderTopWidth) || 0);
        var left = rect.left + (parseInt(rect.borderLeftWidth) || 0);
        var maxTop = rect.bottom - top - text.clientHeight -2;
        var move = function(e) {
            dom.translate(text, e.clientX - left - 2, Math.min(e.clientY - top - 2, maxTop));
        }; 
        move(e);

        if (e.type != "mousedown")
            return;

        host.renderer.$isMousePressed = true;

        clearTimeout(closeTimeout);
        // on windows context menu is opened after mouseup
        if (useragent.isWin)
            event.capture(host.container, move, onContextMenuClose);
    };

    this.onContextMenuClose = onContextMenuClose;
    var closeTimeout;
    function onContextMenuClose() {
        clearTimeout(closeTimeout);
        closeTimeout = setTimeout(function () {
            if (tempStyle) {
                text.style.cssText = tempStyle;
                tempStyle = '';
            }
            host.renderer.$isMousePressed = false;
            if (host.renderer.$keepTextAreaAtCursor)
                host.renderer.$moveTextAreaToCursor();
        }, 0);
    }

    var onContextMenu = function(e) {
        host.textInput.onContextMenu(e);
        onContextMenuClose();
    };
    event.addListener(text, "mouseup", onContextMenu, host);
    event.addListener(text, "mousedown", function(e) {
        e.preventDefault();
        onContextMenuClose();
    }, host);
    event.addListener(host.renderer.scroller, "contextmenu", onContextMenu, host);
    event.addListener(text, "contextmenu", onContextMenu, host);
    
    ///////////////////////////////////////////////////////////////////////////

    if (isIOS)
        addIosSelectionHandler(parentNode, host, text);

    function addIosSelectionHandler(parentNode, host, text) {
        var typingResetTimeout = null;
        var typing = false;
 
        text.addEventListener("keydown", function (e) {
            if (typingResetTimeout) clearTimeout(typingResetTimeout);
            typing = true;
        }, true);

        text.addEventListener("keyup", function (e) {
            typingResetTimeout = setTimeout(function () {
                typing = false;
            }, 100);
        }, true);
    
        // IOS doesn't fire events for arrow keys, but this unique hack changes everything!
        var detectArrowKeys = function(e) {
            if (document.activeElement !== text) return;
            if (typing || inComposition || host.$mouseHandler.isMousePressed) return;

            if (copied) {
                return;
            }
            var selectionStart = text.selectionStart;
            var selectionEnd = text.selectionEnd;
            
            var key = null;
            var modifier = 0;
            // console.log(selectionStart, selectionEnd);
            if (selectionStart == 0) {
                key = KEYS.up;
            } else if (selectionStart == 1) {
                key = KEYS.home;
            } else if (selectionEnd > lastSelectionEnd && lastValue[selectionEnd] == "\n") {
                key = KEYS.end;
            } else if (selectionStart < lastSelectionStart && lastValue[selectionStart - 1] == " ") {
                key = KEYS.left;
                modifier = MODS.option;
            } else if (
                selectionStart < lastSelectionStart
                || (
                    selectionStart == lastSelectionStart 
                    && lastSelectionEnd != lastSelectionStart
                    && selectionStart == selectionEnd
                )
            ) {
                key = KEYS.left;
            } else if (selectionEnd > lastSelectionEnd && lastValue.slice(0, selectionEnd).split("\n").length > 2) {
                key = KEYS.down;
            } else if (selectionEnd > lastSelectionEnd && lastValue[selectionEnd - 1] == " ") {
                key = KEYS.right;
                modifier = MODS.option;
            } else if (
                selectionEnd > lastSelectionEnd
                || (
                    selectionEnd == lastSelectionEnd 
                    && lastSelectionEnd != lastSelectionStart
                    && selectionStart == selectionEnd
                )
            ) {
                key = KEYS.right;
            }
            
            if (selectionStart !== selectionEnd)
                modifier |= MODS.shift;

            if (key) {
                var result = host.onCommandKey({}, modifier, key);
                if (!result && host.commands) {
                    key = KEYS.keyCodeToString(key);
                    var command = host.commands.findKeyCommand(modifier, key);
                    if (command)
                        host.execCommand(command);
                }
                lastSelectionStart = selectionStart;
                lastSelectionEnd = selectionEnd;
                resetSelection("");
            }
        };
        // On iOS, "selectionchange" can only be attached to the document object...
        document.addEventListener("selectionchange", detectArrowKeys);
        host.on("destroy", function() {
            document.removeEventListener("selectionchange", detectArrowKeys);
        });
    }
};

exports.TextInput = TextInput;
exports.$setUserAgentForTests = function(_isMobile, _isIOS) {
    isMobile = _isMobile;
    isIOS = _isIOS;
};
});
