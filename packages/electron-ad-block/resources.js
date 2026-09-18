import { app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { parseFilter, NetworkFilter, FiltersEngine } from '@ghostery/adblocker';

const resources = {
    _setPROPS() {
        Object.assign(this, {
            RESOURCE: [
                ['ublock-resources-json', 'resources.json', true],
                ['ublock-resources', 'resources.txt'],
                ['ublock-unbreak', 'unbreak.txt'],
                ['ublock-quick-fixes', 'quick-fixes.txt'],
                ['ublock-filters', 'filters.txt'],
                ['ublock-filters-2020', 'filters-2020.txt'],
                ['ublock-filters-2021', 'filters-2021.txt'],
                ['ublock-filters-2022', 'filters-2022.txt'],
                ['ublock-filters-2023', 'filters-2023.txt'],
                ['ublock-filters-2024', 'filters-2024.txt'],
                ['ublock-filters-2025', 'filters-2025.txt'],
                ['ublock-filters-2026', 'filters-2026.txt'],
                ['ublock-badware', 'badware.txt'],
                ['ublock-abuse', 'resource-abuse.txt'],
                ['ublock-annoyances-others', 'annoyances-others.txt'],
                ['ublock-annoyances-cookies', 'annoyances-cookies.txt'],
                ['ublock-privacy', 'privacy.txt'],
                ['plowe-0', 'serverlist.txt'],
                ['easylist', 'easylist.txt'],
                ['easyprivacy', 'easyprivacy.txt'],
                ['easylist-cookie', 'easylist-cookie.txt'],
            ],

            ASSETS_URL: 'https://ublockorigin.github.io/uAssetsCDN/ublock/assets.json',
            ghosteryBase: 'https://cdn.ghostery.com/adblocker/resources/',
            badFilters: new Map(),
            seen: new Map(),
            collected: new Map(),
            extMap: new Map(),
            fileAccount: new Map(),
            missing: [],
            updateEver4Days: 345600000,
            remaining: 0,
            timer: null,
            logFile: 'updates.json',
            engine: 'engine.bin',
            ext: [['.bin'], ['.txt'], ['.json'], ['.tmp']],

            states: { 
                isEngine: null,
                engine: null,
                lists: null, 
                nextUpdate: null,
                lastUpdate: null,
            }
        })
    },

    async _loadAssets() {
        const res = await fetch(this.ASSETS_URL).catch(() => null)
        if (!res?.ok) return
        const assets = await res.json()
        const entries = Object.entries(assets)
            .filter(([, v]) => v.content === 'filters' && !v.off)
            .map(([key, v]) => {
                const urls = [...(Array.isArray(v.cdnURLs) ? v.cdnURLs : []), ...[].concat(v.contentURL || [])]
                    .filter(u => u.startsWith('http'))
                return [key, `${key}.txt`, false, urls]
            })
            .filter(([,, , urls]) => urls.length > 0)
        const fromAssets = new Map(entries.map(e => [e[0], e]))
        const merged = this.RESOURCE.map(r => fromAssets.has(r[0]) ? fromAssets.get(r[0]) : r)
        const existing = new Set(merged.map(r => r[0]))
        const extra = entries.filter(e => !existing.has(e[0]))
        this.RESOURCE = [...merged, ...extra]
    },

    _setLog() {
        const log = { "lastUpdate": Date.now().toString(), "nextUpdate": (Date.now() + this.updateEver4Days).toString() }
        fs.writeFileSync(this._getPath(this.logFile), JSON.stringify(log), 'utf-8')
        return log
    },

    _getLog() {
        const log = fs.readFileSync(this._getPath(this.logFile), 'utf-8')
        return JSON.parse(log)
    },

    _isUpdate(log) {
        const next = Number(log.nextUpdate)
        return Number.isNaN(next) || next < Date.now()
    },

    _scheduleUpdate() {
        const log = JSON.parse(fs.readFileSync(this._getPath(this.logFile), 'utf-8'))
        this.remaining = (Number(log.nextUpdate) - Date.now())
        console.log(`[Last adBlock Update]: ${new Date(Number(log.lastUpdate)).toLocaleString()}\n[Next adBlock Update]: ${new Date(Number(log.nextUpdate)).toLocaleString()}`)
        this.timer = setTimeout(() => {
            this._coordinateUpdate()
            .then(() => {
                this._scheduleUpdate()
            })
        }, (this.remaining))
    },

    _getPath(file = '') {
        return path.join(app.getPath('userData'), 'filterList', file);
    },

    _exists(filePath) {
        return fs.existsSync(filePath);
    },

    _storeFile(tmp, data, json, ext) {
        this.extMap.set(tmp, ext)
        fs.writeFileSync(tmp, json ? JSON.stringify(JSON.parse(data), null, 2) : data, 'utf-8')
    },

    _loadFile(file) {
       return fs.readFileSync(this._getPath(file), 'utf-8')
    },

    async _removeFile(file) {
        if (!fs.existsSync(file)) return false
            await fs.promises.rm(file, { recursive: true, force: true })
        return true
    },

    async scan(idx) {
        const entries = await fs.promises.readdir(this._getPath(), { recursive: true, withFileTypes: true }).catch(() => [])
        return entries
            .filter(e => !e.isDirectory())
            .map(e => path.join(e.parentPath, e.name))
            .filter(f => this.ext[idx].includes(path.extname(f).toLowerCase()))
    },

    async _renameFiles(file, tmp) {
        let store
        if (fs.existsSync(file)) {
            store = fs.readFileSync(file)
            if (!await this._removeFile(file)) return
        }
        await fs.promises.rename(tmp, file)
        .catch( async() => await fs.promises.writeFile(file, store) )
    },


    async _update() {
        const tryUrls = async (urls) => {
            for (const url of urls) {
                const res = await fetch(url).catch(() => null)
                if (res?.ok) return res
            }
            return null
        }

        const ghosteryFetch = async (resource) => {
            const meta = await tryUrls([`${this.ghosteryBase}${resource}/metadata.json`])
            if (!meta) return null
            const { revisions } = await meta.json()
            return tryUrls([`${this.ghosteryBase}${resource}/${revisions.at(-1)}/list.txt`])
        }

        await Promise.allSettled(
            this.missing.map(
                async ([resource, file, json=false, urls]) => {
                    const isGhostery = !urls
                    const res = isGhostery ? await ghosteryFetch(resource) : await tryUrls(urls)
                    if (!res?.ok) return
                    const result = await res.text()
                    this.collected.set(resource,
                        {
                            result,
                            resource,
                            name: path.basename(file, path.extname(file)),
                            ext: path.extname(file).slice(1),
                            json
                        }
                    )
                }
            )
        )
        this.collected.forEach(({ result, resource, name, ext, json }) => {
            let tmp = `${this._getPath(name + '.' + ext)}.tmp`
            if (resource === 'ublock-resources-json' || resource === 'ublock-resources') return this._storeFile(tmp, result, json, ext)
            else 
            {
                const lines = result
                .split(/[\r\n]/g)
                .map((line) => line.trim())
                .map((line) => {
                    const filter = parseFilter(line);
                    if (filter === null) return line;
                    if (filter instanceof NetworkFilter) {
                        if (filter.isBadFilter()) {
                            this.badFilters.set(filter.getIdWithoutBadFilter(), tmp)
                            return `! [badfilter] ${line}`;
                        }
                        const badFilter = this.badFilters.get(filter.getIdWithoutBadFilter());
                        if (badFilter !== undefined)
                            return `! [badfilter] from ${badFilter}\n! ${line}`;
                    }
                    const dup = this.seen.get(filter.getId());
                    if (dup !== undefined) return `! [dup] from ${dup}\n! ${line}`;
                    this.seen.set(filter.getId(), tmp)
                    return line
                });
                
                const data = lines.join('\n')
                this.fileAccount.set(name, data)
                this._storeFile(tmp, data, json, ext)
            }   
        })
        this.collected.clear()
        return true
    },

    _missingResources() { 
        this.RESOURCE.map(ent => ent[1])
        .forEach(e => {
           if (!this._exists(this._getPath(e))) this.missing.push(this.RESOURCE.find(ent => ent[1] === e))
        })
        return this.missing.length > 0
    },

    async _coordinateUpdate() {
            if (await this._update()) {
                for (const tmp of await this.scan(3)) {
                    if (this.extMap.has(tmp)) {
                        await this._renameFiles(tmp.slice(0, -4), tmp)
                    }
                }
                this.extMap.clear()
                this.missing = []
                this.seen.clear()
                this.badFilters.clear()
                return true
            }
            return false
    },

    _returnListArray(allFiles) {
        if (this.fileAccount.size > 0 && this.RESOURCE.slice(2)
            .map(r => path.basename(r[1], path.extname(r[1])))
            .every((name) => {
                if (!this.fileAccount.has(name)) {
                    const filePath = allFiles.find(f => path.basename(f, path.extname(f)) === name)
                    if (filePath) this.fileAccount.set(name, fs.readFileSync(filePath, 'utf-8'))
                }
                return this.fileAccount.has(name)
            })) return [...this.fileAccount.values()]
            else return [...allFiles.map(file => fs.readFileSync(file, 'utf-8'))]
    },

    async _betterCheckIsOnlineFirst() {
       return new Promise(resolve => {
            const check = () => net.isOnline() ? resolve(true) : setTimeout(check, 5000)
            check()
        })
    },

    async _buildEngine() {
        const lists = this._returnListArray(await this.scan(1))
        const engine = FiltersEngine.parse(lists.join('\n'))
        const resources = this._loadFile('resources.json')
        engine.updateResources(resources, '' + resources.length)
        fs.writeFileSync(this._getPath(this.engine), engine.serialize())
        return engine
    },

    async controller() {
        let updated = false;
        let isEngine = true;
        let log = null;

        this._setPROPS()

        await this._betterCheckIsOnlineFirst()

        const startUpdate = async() => {
            updated = await this._coordinateUpdate()
            if (updated) { 
                log = this._setLog()
                const arr = await this.scan(0)
                if (arr.length > 0)
                    for (const file of arr) await this._removeFile(file)
            }
        }

        await this._loadAssets()

        if (!['', this.logFile].every(ent => this._exists(this._getPath(ent)))) {
            this.missing = this.RESOURCE
            fs.mkdirSync(this._getPath(''), { recursive: true })
            await startUpdate()
        }

        log = this._getLog()

        if (this._isUpdate(log)) {
            this.missing = this.RESOURCE
            await startUpdate()
        }

        if (!this._exists(this._getPath(this.engine))) {
            if (this._missingResources() && !updated) {
                await startUpdate()
            }
            const engine = await this._buildEngine()
            isEngine = !!engine
            this.states.engine = engine
        } else {
            this.states.engine = FiltersEngine.deserialize(fs.readFileSync(this._getPath(this.engine)))
        }

        this.states.isEngine = isEngine
        this.states.lists = this._returnListArray(await this.scan(1))
        this.states.nextUpdate = Number(log.nextUpdate)
        this.states.lastUpdate = Number(log.lastUpdate)
            
        this._scheduleUpdate()
        return this.states
    }
}

export default resources