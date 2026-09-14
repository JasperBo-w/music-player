'use strict';

/**
 * 接口模块注册表
 *
 * vendor/ 目录下有 215 个接口模块，这里只显式注册 App 真正用到的那些。
 *
 * 为什么不用动态 require 扫描目录：
 *   - React Native 的 Metro 打包器要求 require 路径是静态字面量，
 *     动态拼接路径在手机上会直接打包失败；
 *   - 显式清单顺带控制了移动端的包体积。
 * 需要新接口时，在这里加一行即可。
 */

module.exports = {
  // ---------- 登录 / 设备 ----------
  login_qr_key: require('./kugou/vendor/module/login_qr_key.js'),
  login_qr_create: require('./kugou/vendor/module/login_qr_create.js'),
  login_qr_check: require('./kugou/vendor/module/login_qr_check.js'),
  login_cellphone: require('./kugou/vendor/module/login_cellphone.js'),
  login_token: require('./kugou/vendor/module/login_token.js'),
  register_dev: require('./kugou/vendor/module/register_dev.js'),

  // ---------- 用户 ----------
  user_detail: require('./kugou/vendor/module/user_detail.js'),
  user_info: require('./kugou/vendor/module/user_info.js'),
  user_playlist: require('./kugou/vendor/module/user_playlist.js'),
  user_history: require('./kugou/vendor/module/user_history.js'),
  user_vip_detail: require('./kugou/vendor/module/user_vip_detail.js'),
  user_listen: require('./kugou/vendor/module/user_listen.js'),
  user_cloud: require('./kugou/vendor/module/user_cloud.js'),

  // ---------- 歌单 ----------
  playlist_detail: require('./kugou/vendor/module/playlist_detail.js'),
  playlist_track_all: require('./kugou/vendor/module/playlist_track_all.js'),
  playlist_track_all_new: require('./kugou/vendor/module/playlist_track_all_new.js'),
  playlist_tags: require('./kugou/vendor/module/playlist_tags.js'),
  playlist_similar: require('./kugou/vendor/module/playlist_similar.js'),
  top_playlist: require('./kugou/vendor/module/top_playlist.js'),
  theme_playlist: require('./kugou/vendor/module/theme_playlist.js'),

  // ---------- 歌曲 / 歌词 ----------
  song_url: require('./kugou/vendor/module/song_url.js'),
  song_url_new: require('./kugou/vendor/module/song_url_new.js'),
  song_climax: require('./kugou/vendor/module/song_climax.js'),
  song_auth: require('./kugou/vendor/module/song_auth.js'),
  lyric: require('./kugou/vendor/module/lyric.js'),
  search_lyric: require('./kugou/vendor/module/search_lyric.js'),

  // ---------- 搜索 ----------
  search: require('./kugou/vendor/module/search.js'),
  search_complex: require('./kugou/vendor/module/search_complex.js'),
  search_mixed: require('./kugou/vendor/module/search_mixed.js'),
  search_suggest: require('./kugou/vendor/module/search_suggest.js'),
  search_hot: require('./kugou/vendor/module/search_hot.js'),
  search_default: require('./kugou/vendor/module/search_default.js'),

  // ---------- 推荐 / 排行 ----------
  everyday_recommend: require('./kugou/vendor/module/everyday_recommend.js'),
  everyday_history: require('./kugou/vendor/module/everyday_history.js'),
  recommend_songs: require('./kugou/vendor/module/recommend_songs.js'),
  personal_fm: require('./kugou/vendor/module/personal_fm.js'),
  fm_songs: require('./kugou/vendor/module/fm_songs.js'),
  rank_list: require('./kugou/vendor/module/rank_list.js'),
  rank_info: require('./kugou/vendor/module/rank_info.js'),
  rank_audio: require('./kugou/vendor/module/rank_audio.js'),
  top_song: require('./kugou/vendor/module/top_song.js'),

  // ---------- 专辑 / 歌手 ----------
  album: require('./kugou/vendor/module/album.js'),
  album_detail: require('./kugou/vendor/module/album_detail.js'),
  album_songs: require('./kugou/vendor/module/album_songs.js'),
  artist_detail: require('./kugou/vendor/module/artist_detail.js'),
  artist_audios: require('./kugou/vendor/module/artist_audios.js'),
  artist_albums: require('./kugou/vendor/module/artist_albums.js'),
  singer_list: require('./kugou/vendor/module/singer_list.js'),

  // ---------- 播放历史 / 同步 ----------
  playhistory_upload: require('./kugou/vendor/module/playhistory_upload.js'),
  lastest_songs_listen: require('./kugou/vendor/module/lastest_songs_listen.js'),

  // ---------- 歌单编辑 ----------
  playlist_add: require('./kugou/vendor/module/playlist_add.js'),
  playlist_del: require('./kugou/vendor/module/playlist_del.js'),
  playlist_tracks_add: require('./kugou/vendor/module/playlist_tracks_add.js'),
  playlist_tracks_del: require('./kugou/vendor/module/playlist_tracks_del.js'),
};
