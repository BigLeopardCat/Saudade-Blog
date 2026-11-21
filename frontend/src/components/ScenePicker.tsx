import {t as tr, useLocale} from '../i18n';
import {useEffect, useRef, useState} from 'react'
import {SCENES, useSceneTheme} from '../sceneTheme'
import SceneIcon from './SceneIcon'
import '../scene.css'

export default function ScenePicker({dark, onOpenChange}: {dark: boolean; onOpenChange?: (open: boolean) => void}) {
    useLocale();
    const {scene, choose} = useSceneTheme(dark)
    const [open, setOpen] = useState(false)
    useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false) }, [open, onOpenChange])
    const root = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) return
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
        }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', escape)
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
    }, [open])
    return <div className="scenePicker" ref={root}>
        <button className="sceneTool" type="button" ref={trigger} aria-label={tr("切换场景主题")} title={tr("切换场景主题")} aria-expanded={open} aria-controls="scene-options" onClick={() => setOpen(value => !value)}><SceneIcon name="palette"/></button>
        {open && <div className="sceneOptions" id="scene-options" role="group" aria-label={tr("场景主题")}>
            <div className="sceneOptionsHeading">{tr("选一处风景")}</div>
            {SCENES.map(item => <button type="button" key={item.id} aria-pressed={scene === item.id} onClick={() => { choose(item.id); setOpen(false); trigger.current?.focus() }}>
                <img src={item.thumbnail} alt="" width="80" height="48"/>
                <span><strong>{tr(item.name)}</strong><small>{tr(item.note)}</small></span><span className="sceneSelected" aria-hidden="true">{scene === item.id ? '✓' : ''}</span>
            </button>)}
        </div>}
    </div>
}
