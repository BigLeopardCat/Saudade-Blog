import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Dispatch } from 'react';
import {CategoriesType} from "../../interface/CategoriesType";
import {getCategories} from "../../apis/CategoryMethods.tsx";
interface categoryList {
    categories: CategoriesType[],
    categoryCount: number
}

const init: categoryList = {
    categories: [],
    categoryCount: 0
}


const categoriesSlice = createSlice({
    name: "categories",
    initialState: init,
    reducers: {
        setCategories: (state,action:PayloadAction<CategoriesType[]>) => {
            state.categories = action.payload
        },
        setCategoryCount: (state,action) => {
            state.categoryCount = action.payload
        }
    }
})

const fetchCategories = () => {
    return async (dispatch:Dispatch<PayloadAction<CategoriesType[]>>) => {
        try {
            const res = await getCategories()
            if (res?.data?.code !== 200 || !Array.isArray(res.data.data)) return false
            const categories = res.data.data
            dispatch(setCategories(categories))
            dispatch(setCategoryCount(categories.length))
            return true
        }catch (error) {
            console.error('分类加载失败', error)
            return false
        }
    }
}

const {setCategories,setCategoryCount} = categoriesSlice.actions
const categoriesReducer = categoriesSlice.reducer


export {setCategories, fetchCategories};
export type { categoryList };
export default categoriesReducer