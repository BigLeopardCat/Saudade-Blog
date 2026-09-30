import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import http from '../../apis/axios.tsx';
import { Dispatch } from 'react';
import UserState from "../../interface/UserState";
import UserData from "../../interface/UserData";
import deleteToken from "../../apis/deleteToken.tsx";
import {SocialType} from "../../interface/SocialType";

const initialState: UserState = {
    token: localStorage.getItem('tokenKey') || null,
    avatar: '',
    talk: '',
    name: '',
    social: null,
    blogTitle: '',
    blogIcp: '',
    blogPublicIcp: '',
    blogCopyright: ''
};

const userSlice = createSlice({
    name: 'user',
    initialState,
    reducers: {
        setToken: (state: UserState, action: PayloadAction<{ token: string }>) => {
            state.token = action.payload.token;
            localStorage.setItem('tokenKey', action.payload.token);
            // 20260830：通知聊天面板账号已切换（对话面板不感知 React 状态——
            // 清空旧账号会话重拉新历史，见 chat-engine.js auth-change 监听）
            window.dispatchEvent(new CustomEvent('auth-change'));
        },
        setUserInfo: (state: UserState,action: PayloadAction<{avatar:string,talk:string,name:string,blogTitle: string,blogIcp: string,blogPublicIcp: string,blogCopyright: string}>) => {
            state.avatar = action.payload.avatar;
            state.talk = action.payload.talk;
            state.name = action.payload.name;
            state.blogIcp = action.payload.blogIcp;
            state.blogTitle = action.payload.blogTitle
            state.blogPublicIcp = action.payload.blogPublicIcp;
            state.blogCopyright = action.payload.blogCopyright;
        },
        setSocial: (state: UserState,action: PayloadAction<SocialType>) => {
            state.social = action.payload
        }
    },
});

const { setToken,setUserInfo,setSocial } = userSlice.actions;
const userReducer = userSlice.reducer;

const fetchToken = (data: UserData) => {
    return async (dispatch: Dispatch<PayloadAction<{ token: string }>>) => {
        // 原来是 try/catch 里 `throw error`（纯转抛）：调用方照样收到 rejected promise，
        // 包一层只是把同一个异常多搬一次手，去掉后行为不变。
        const res = await http({
            url: '/api/login',
            method: 'POST',
            data: data
        });

        if (res.data.code === 200) {
            const token = res.data.data;
            dispatch(setToken({ token: token}));
            return { status: 200 };
        } else {
            return { status: res.data.code || 500, message: res.data.message || '登录失败' };
        }
    };
};

const fetchUserInfo = () => {
    return async (dispatch: Dispatch<PayloadAction<{avatar:string,talk:string}>>) => {
        try{
            const userinfo = await http({
                url: '/api/public/user',
                method: "GET"
            })
            // 后端这些键是 `Option<String>`，没配过就是 **null**（不是空串）。
            // 统一归一成空串：消费者（页脚/首页）判的是"空 ⇒ 不渲染"，
            // 让 null 漏进去会让 `{v}` 渲染成空白但仍占位、`if (v)` 却又是假，两处判断打架。
            const s = (v: unknown) => (typeof v === 'string' ? v : '')
            const res = {
                avatar: s(userinfo.data.data.userAvatar),
                talk: s(userinfo.data.data.userTalk),
                name: s(userinfo.data.data.blogAuthor),
                blogTitle: s(userinfo.data.data.blogTitle),
                blogIcp: s(userinfo.data.data.blogIcp),
                blogPublicIcp: s(userinfo.data.data.blogPublicIcp),
                blogCopyright: s(userinfo.data.data.blogCopyright),
            }
            dispatch(setUserInfo(res))
        }catch (error){
            deleteToken()
        }
    }
}

const fetchSocial = () => {
    return async (dispatch: Dispatch<PayloadAction<SocialType>>) => {
        try {
            const social = await http({
                url: '/api/public/social',
                method: "GET"
            })
            dispatch(setSocial(social.data.data))
        }catch (error){
            console.error('Failed to fetch social');
        }
    }
}


export { setToken, fetchToken,fetchUserInfo,fetchSocial };
export default userReducer;
