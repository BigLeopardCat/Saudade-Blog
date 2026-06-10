import './index.sass'
import {useSelector} from "react-redux";
import { TagCloud } from 'react-tagcloud'
const WordCloud = () => {
    // @ts-ignore
    const categories = useSelector((state) => state.categories.categories);
    const categoryList = Array.isArray(categories) ? categories : [];
    const cloudTags = categoryList.map(item => {
        return {
            value: item.categoryTitle,
            count: item.noteCount
        }
    })

    return <div className="wordCloud">
        <TagCloud
            minSize={10}
            maxSize={35}
            tags={cloudTags}
        />
    </div>
}

export default WordCloud