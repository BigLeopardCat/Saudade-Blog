import riversideThumb from './assets/scenes/riverside-thumb.webp'
import stationThumb from './assets/scenes/station-thumb.webp'
import atelierThumb from './assets/scenes/atelier-thumb.webp'
import rainThumb from './assets/scenes/rain-thumb.webp'
import {useEffect, useState} from 'react'

export const SCENES = [
    {id: 'riverside', thumbnail: riversideThumb, name: '樱花河岸', note: '水光与春樱'},
    {id: 'station', thumbnail: stationThumb, name: '春日车站', note: '等一班春天'},
    {id: 'atelier', thumbnail: atelierThumb, name: '画室窗边', note: '把日常画成风景'},
    {id: 'rain', thumbnail: rainThumb, name: '雨后暮色', note: '灯火与晚樱'},
] as const
export type Scene = typeof SCENES[number]['id']
const KEY = 'saudade.scene'
export function readScene(): Scene {
    try {
        const saved = localStorage.getItem(KEY)
        if (SCENES.some(scene => scene.id === saved)) return saved as Scene
    } catch { /* Storage can be unavailable in private browsing. */ }
    return 'atelier'
}
export function applyScene(scene: Scene): void {
    document.documentElement.dataset.scene = scene
}
export function useSceneTheme(dark: boolean) {
    const [scene, setScene] = useState<Scene>(readScene)
    useEffect(() => { applyScene(scene) }, [scene])
    useEffect(() => { document.documentElement.dataset.sceneDark = String(dark) }, [dark])
    useEffect(() => {
        const sync = (event: StorageEvent) => { if (event.key === KEY) setScene(readScene()) }
        window.addEventListener('storage', sync)
        return () => window.removeEventListener('storage', sync)
    }, [])
    const choose = (value: Scene) => {
        applyScene(value)
        setScene(value)
        try { localStorage.setItem(KEY, value) } catch { /* Keep the session choice. */ }
    }
    return {scene, choose}
}
