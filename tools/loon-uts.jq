def query_value($key):
  split("&")
  | map(select(startswith($key + "=")) | ltrimstr($key + "="))
  | first;

def bridge($path; $revision; $source):
  "https://hls-amt.itunes.apple.com" + $path + "?rev="
  + ($revision | @uri) + "&src=" + ($source | @uri);

def playback_url($catalog):
  . as $original
  | sub("^https://play-edge-cdn\\.itunes\\.apple\\.com"; "https://play-edge.itunes.apple.com"; "i")
  | sub("^https://play-cdn\\.itunes\\.apple\\.com"; "https://play.itunes.apple.com"; "i")
  | . as $source
  | ([capture("^https://(?<host>[A-Za-z0-9.-]+)(?<path>/[^?#]*)(?:\\?(?<query>[^#]*))?$"; "i")][0]) as $url
  | ($url.host // "" | ascii_downcase) as $host
  | ($url.query // "") as $query
  | if $host == "linear.tv.apple.com" and $url.path == "/v1/hls/playlist.m3u8" then
      ($query | query_value("referenceId")) as $reference
      | ([$catalog.previews[] | select(.referenceId == $reference)][0]) as $preview
      | if $preview then bridge($preview.masterPath; $preview.revision; $original) else $original end
    elif $host == "play.itunes.apple.com" or $host == "play-edge.itunes.apple.com" then
      ([$catalog.series | to_entries[] | .key as $asset | select($original | contains($asset))][0]) as $episode
      | ($query | query_value("id")) as $program
      | ($query | query_value("a")) as $asset
      | ([$catalog.replays[] | select(.programId == $program and .assetId == $asset)][0]) as $replay
      | if $episode then
          bridge("/__apple_series_master/" + $episode.value + "/index.m3u8"; "dts8-20260920d"; $source)
        elif $replay and $url.path == "/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8" then
          bridge("/__f1_replay_master/" + $replay.slug + "/index.m3u8"; $replay.revision; $source)
        else
          ([$catalog.movies | to_entries[] | .key as $id | select($original | contains($id))][0]) as $movie
          | if $movie then
              ($catalog.revisions[$movie.key] // (if $movie.key == "6796433608" then "v260925a" else "v260904a" end)) as $revision
              | bridge("/__apple_movie_master/" + $movie.value + "/index.m3u8"; $revision; $source)
            else $original end
        end
    else $original end;

__CATALOG__ as $catalog
| walk(if type == "object" and (.hlsUrl | type == "string") then .hlsUrl |= playback_url($catalog) else . end)
