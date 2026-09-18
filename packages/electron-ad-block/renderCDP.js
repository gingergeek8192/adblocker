
const renderCDP = {

    DOMNodes: class {
        constructor (build) {
            Object.assign(this, build)
            this.main = new Map()
            this.sessionIds = new Set()
            this.iframes = []
        }

        async getSerialised(sessionId = null) {
            let PARENT = null;
            let CHILD = null;
            const getDocFrames = async(sid = null) => {
                const { strings, documents } = await this.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', {
                        computedStyles: [ 'display', 'visibility', 'pointer-events', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'margin', 'padding', 'box-sizing' ],
                        includeDOMRects: true,
                        includePaintOrder: false
                    }, sid)

                const { frameTree } = await this.webContents.debugger.sendCommand('Page.getResourceTree', {}, sid)
                return { strings, documents, frameTree }
            }
                const buildTree = (strings, documents) => {
                return documents.map(({ nodes: {
                        parentIndex,
                        nodeType,
                        nodeName,
                        nodeValue,
                        backendNodeId,
                        attributes
                    }, layout }) => {
                    const rects = new Map()
                    if (layout) {
                        for (let i = 0; i < layout.nodeIndex.length; i++) {
                            rects.set(layout.nodeIndex[i], layout.bounds[i])
                        }
                    }
                    const nodes = nodeName.map((name, i) => {
                        const attrs = attributes[i]
                        const parsed = {}
                        for (let a = 0; a < attrs.length; a += 2)
                            parsed[strings[attrs[a]]] = attrs[a + 1] === -1 ? true : strings[attrs[a + 1]]
                        const bounds = rects.get(i)
                        return {
                            index: i,
                            nodeType: nodeType[i],
                            nodeName: strings[name],
                            nodeValue: nodeValue[i] === -1 ? null : strings[nodeValue[i]],
                            backendNodeId: backendNodeId[i],
                            attributes: parsed,
                            boundingRect: bounds ? {
                                x: bounds[0],
                                y: bounds[1],
                                width: bounds[2],
                                height: bounds[3]
                            } : null,
                            children: []
                        }
                    })

                    for (let i = 0; i < nodes.length; i++) {
                        if (nodes[i].nodeType === 3 && !nodes[i].nodeValue?.trim()) continue
                        const parent = nodes[parentIndex[i]]
                        if (parent) parent.children.push(nodes[i])
                    }
                    return nodes[0]
                })
            }
            const { strings, documents, frameTree } = await getDocFrames()
            if (!strings || !documents || !frameTree) return
            if (!frameTree.frame.parentId)  {
                this.parentFrameId = frameTree?.frame?.id
                this.main.set(
                    frameTree.frame.id, { 
                        time: Date.now(),
                        frameTree: frameTree,
                        document: { 
                            ...buildTree(strings, documents)[0],
                            url: frameTree.frame.url,
                            id: frameTree.frame.id
                        }
                    }
                )
            }
            if (sessionId) {
                if (!this.sessionIds.has(sessionId)) this.sessionIds.add(sessionId)
                    for (const sid of this.sessionIds) {
                    await this.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'true', returnByValue: true }, sid)
                        .then( 
                            async()=> { 
                                const { strings: childStrings, documents: childDocs, frameTree: childTree } = await getDocFrames(sid)
                                if (childTree.frame.parentId)
                                    this.iframes.push({
                                        time: Date.now(),
                                        sessionId: sid,
                                        frameTree: childTree,
                                        document: { 
                                            ...buildTree(childStrings, childDocs)[0],
                                            url: childTree.frame.url,
                                            id: childTree.frame.id
                                        }
                                    })
                            }
                        )
                        .catch(()=>  {
                            this.sessionIds.delete(sid)
                            this.iframes.filter(iframe => iframe.sessionId !== sid)
                        })
                    }
            }
            if (this.main.size > 0) {
                PARENT = [...this.main.values()].sort((a, b)=> a.time - b.time)[0]
            }
            if (this.iframes.length) {
                const frameDocs = new Set()
                this.iframes = this.iframes.filter(iframe => !frameDocs.has(iframe.document.url) && frameDocs.add(iframe.document.url))
                CHILD = this.iframes.sort((a, b)=> a.time - b.time)
            }
            return {
                main: PARENT,
                iframe: CHILD,
            }
        }
    },



}

export default renderCDP