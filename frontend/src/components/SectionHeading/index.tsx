import type {ReactNode} from 'react'
import SceneIcon from '../SceneIcon'
import './index.sass'
export default function SectionHeading({icon, children}: {icon: 'top' | 'document'; children: ReactNode}) {
    return <h2 className="homeSectionTitle"><SceneIcon name={icon} size={23}/><span>{children}</span></h2>
}
