// Copyright: Hiroshi Ichikawa <http://gimite.net/en/>
// License: New BSD License

if (!window.console) console = {log: function(){ }, error: function(){ }};

google.load("jquery", "1.5.1");
google.load("jqueryui", "1.8.4");

WEB_SOCKET_SWF_LOCATION = "/js/WebSocketMain.swf?version=3";
// WEB_SOCKET_DEBUG = true;
FRAME_MSEC = 40;
ANIMATION_MAX_DELAY_MSEC = 1000;
PING_INTERVAL_MSEC = 5 * 60 * 1000;

  var MESSAGES = {
    tps: "tweets/sec",
    flashPlayerRequired:
      "Flash Player 10 or later is required. Install the latest Flash Player.",
    noTweets: "No tweets found.",
    aSecondAgo: "1 second ago",
    secondsAgo: "%d seconds ago",
    lessThanSecondsAgo: "less than %d seconds ago",
    lessThanAMinuteAgo: "less than 1 minute ago",
    aMinuteAgo: "1 minute ago",
    minutesAgo: "%d minutes ago",
    anHourAgo: "1 hour ago",
    hoursAgo: "%d hours ago",
    beforeSource: " from ",
    afterSource: "",
    retweetedBy: "Retweeted by %s",
    DISCONNECTED: "Disconnected.",
    POST_ERROR: "Error posting your tweet.",
    SEARCH_ERROR: "Search failed.",
    TOO_MANY_TERMS: "Auto update doesn't work because the query has more than 4 hash tags.",
    QUERY_TOO_LONG: "Auto update doesn't work because the query is too long.",
    QUERY_NOT_HASH_TAGS: "Auto update works only for hash tags.",
    QUERY_NOT_HASH_TAGS_WITH_SUGGEST:
      "Auto update works only for hash tags. Try related hash tags: "
  };

var query = vars.query;
var webSocketUrl = vars.web_socket_url;
var lang = vars.lang;

var ws;
var entries = [];
var displayQue = [];
var showing = false;
var streamErrorReported = false;
var onEntriesCallbacks = [];
var leftClosed = false;

function initialize() {
  if (!window.WebSocket) {
    alert(MESSAGES.flashPlayerRequired);
    return;
  }
  if (query) {
    openWebSocket();
    startClockTimer();
  }
  showBuzz();
  onWindowResize();
  $(window).resize(onWindowResize);
  $("#close-left-button").click(onCloseLeftButtonClick);
  $("#retry-link").click(onRetryLinkClick);
  $("#show-update-link").click(onShowUpdateLinkClick);
  $("#update-form").submit(onUpdateFormSubmit);
  addOnEntries(onEntries);
}

function onWindowResize() {
  if (!leftClosed) setLeftColumnVisible($("body").width() >= 600);
}

function onCloseLeftButtonClick() {
  leftClosed = true;
  setLeftColumnVisible(false);
}

function setLeftColumnVisible(visible) {
  if (visible) {
    $("#left-column").show();
    $(".center-column").removeClass("left-hidden");
    $(".result-container").removeClass("left-hidden");
  } else {
    $("#left-column").hide();
    $(".center-column").addClass("left-hidden");
    $(".result-container").addClass("left-hidden");
  }
}

function onRetryLinkClick(e) {
  e.preventDefault();
  location.reload();
}

function onShowUpdateLinkClick(e) {
  e.preventDefault();
  $("#update").show();
  focusOnUpdateField();
}

function onUpdateFormSubmit(e) {
  e.preventDefault();
  var status = $("#update-field").val();
  $("#update-field").val(" " + query);
  focusOnUpdateField();
  $("#update-progress").show();
  console.log("update: " + status);
  $.ajax({
    type: "POST",
    url: "/update",
    data: {status: status},
    success: function() {
      console.log("update success");
      $("#update-progress").hide();
    },
    error: function() {
      $("#update-progress").hide();
      showError(MESSAGES.POST_ERROR, false);
    }
  });
}

function openWebSocket() {
  var url = webSocketUrl + "?q=" + encodeURIComponent(query);
  console.log("openWebSocket", url);
  ws = new WebSocket(url);
  ws.onopen = onWebSocketOpen;
  ws.onmessage = onWebSocketMessage;
  ws.onclose = onWebSocketClosed;
  ws.onerror = onWebSocketClosed;
}

function startClockTimer() {
  setInterval(function() {
    updateTweetsPerSec();
    for (var i = 0; i < entries.length; ++i) {
      updateDate(entries[i]);
    }
  }, 1000);
}

function onWebSocketOpen() {
  console.log("ws.onopen");
  setInterval(function() {
    ws.send("");  // Sends ping.
  }, PING_INTERVAL_MSEC);
}

function onWebSocketMessage(e) {
  //console.log("onmessage: " + e.data);
  // First message keeps latest 50 tweets, not real-time tweets.
  var history = entries.length == 0;
  var result = eval("(" + e.data + ")");
  if (result.entries) {
    for (var i = 0; i < result.entries.length; ++i) {
      convertEntry(result.entries[i], history);
    }
    for (var i = 0; i < onEntriesCallbacks.length; ++i) {
      onEntriesCallbacks[i](result.entries, history);
    }
  } else {
    showError(result.error, false, result);
    streamErrorReported = true;
  }
}

function onEntries(newEntries, history) {
  for (var i = 0; i < newEntries.length; ++i) {
    var entry = newEntries[i];
    if (history) {
      if (!entry.retweeted_status) {
        createView(entry);
        entries.splice(0, 0, entry);  // inserts the entry to front
        $("#result").prepend(entry.statusDiv);
      }
    } else {
      queryShowEntry(entry);
    }
  }
  if (newEntries.length > 0) {
    $("#result-message").hide();
  } else if (history) {
    $("#result-message").text(MESSAGES.noTweets);
  }
  if (history) updateTweetsPerSec();
}

function addOnEntries(callback) {
  onEntriesCallbacks.push(callback);
}

function convertEntry(entry, history) {
  entry.unescaped_text = unescapeHtml(entry.text || "");
  entry.unescaped_source = unescapeHtml(entry.source || "");
  // Local clock may be inaccurate, so recalculates the creation time in local clock.
  // IE doesn't accept +0000 format.
  var remoteCreatedAt = new Date(entry.created_at.replace(/\+0000/, "UTC"));
  var remoteNow = new Date(entry.now * 1000);
  var localNow = new Date();
  // local_created_at:
  //   The time when the entry was posted. Used to show the time posted.
  // local_updated_at:
  //   The time when the entry was received by the client (unless it's in the history),
  //   or retweet of the entry was received.
  //   Tweet/sec is calculated with this, to make calculation a bit more accurate, and
  //   to make sure the entries in displayQue and entries are sorted by the field.
  entry.local_created_at = localNow.getTime() - (remoteNow - remoteCreatedAt);
  entry.local_updated_at = history ? entry.local_created_at : localNow.getTime();
  if (entry.retweeted_status) {
    entry.retweeted_status.now = entry.now;
    convertEntry(entry.retweeted_status);
  }
}

function onWebSocketClosed() {
  console.log("ws.onclose or ws.onerror");
  if (!streamErrorReported) showError(MESSAGES.DISCONNECTED, true);
  $("#result-message").hide();
}

function queryShowEntry(entry) {
  //console.log("queryShowEntry", entry);
  displayQue.push(entry);
  updateAnimationSpeed();
  if (!showing) showEntryInQueue();
}

function updateAnimationSpeed() {
  // Modifies animation speed so that the new entry is displayed in ANIMATION_MAX_DELAY_MSEC
  // from now.
  var animationMsec = ANIMATION_MAX_DELAY_MSEC / (displayQue.length);
  for (var i = 0; i < displayQue.length; ++i) {
    if (!displayQue[i].animation_msec || displayQue[i].animation_msec > animationMsec) {
      displayQue[i].animation_msec = animationMsec;
    }
  }
}

function showEntryInQueue() {
  
  while (entries.length > 50) {
    var removedEntry = entries.pop();
    removedEntry.statusDiv.remove();
  }
  
  if (displayQue.length == 0) {
    showing = false;
    return;
  }
  showing = true;
  var numSkipped = 0;
  if (displayQue.length > 50) {
    // Too many entries in the queue. Likely more entries are coming than processed.
    numSkipped = displayQue.length - 50;
    console.log("skip", numSkipped);
    displayQue.splice(0, numSkipped);
  }
  var entry = displayQue[0];
  entry.num_skipped = numSkipped;
  displayQue.splice(0, 1);
  
  if (entry.retweeted_status) {
    var retweetedEntry = null;
    for (var i = 0; i < entries.length; ++i) {
      if (entries[i].id_str == entry.retweeted_status.id_str) {
        retweetedEntry = entries[i];
        break;
      }
    }
    if (!retweetedEntry) {
      retweetedEntry = entry.retweeted_status;
    }
    retweetedEntry.local_updated_at = entry.local_updated_at;
    retweetedEntry.last_retweeter = entry.user.screen_name;
    retweetedEntry.animation_msec = entry.animation_msec;
    retweetedEntry.num_skipped = entry.num_skipped;
    raiseEntry(retweetedEntry);
  } else {
    prependEntry(entry);
  }
  
}

function prependEntry(targetEntry) {
  
  if (!targetEntry.statusDiv) createView(targetEntry);
  entries.splice(0, 0, targetEntry);  // inserts the entry to front
  $("#result").prepend(targetEntry.statusDiv);
  var height = targetEntry.statusDiv.height();
  
  var progress = 0;
  function animate() {
    if (progress > 1) progress = 1;
    $("#result").css("top", -height * (1 - progress));
    if (progress < 1) {
      progress += FRAME_MSEC / targetEntry.animation_msec;
      setTimeout(animate, FRAME_MSEC);
    } else {
      setTimeout(showEntryInQueue, FRAME_MSEC);
    }
  }
  animate();
  
}

function raiseEntry(targetEntry) {
  
  if (!targetEntry.statusDiv) createView(targetEntry);
  
  var targetIndex = getEntryIndex(targetEntry);
  if (targetIndex == 0) {
    showEntryInQueue();
    return;
  }
  var movedEntries = entries.slice(0, targetIndex);
  
  targetEntry.statusDiv.css("z-index", 1);
  targetEntry.retweeterSpan.text(MESSAGES.retweetedBy.replace("%s", targetEntry.last_retweeter));
  
  entries.splice(targetIndex, 1);
  entries.splice(0, 0, targetEntry);
  movedEntries[0].statusDiv.before(targetEntry.statusDiv);
  
  var entryHeight = targetEntry.statusDiv.height();
  var dist = 0;
  for (var i = 0; i < movedEntries.length; ++i) {
    dist += movedEntries[i].statusDiv.height();
  }
  if (dist > 800) dist = 800;  // to prevent too quick animation
  
  var progress = 0;
  function animate() {
    if (progress > 1) progress = 1;
    targetEntry.statusDiv.css("top", dist * (1 - progress));
    for (var i = 0; i < movedEntries.length; ++i) {
      movedEntries[i].statusDiv.css("top", -entryHeight * (1 - progress));
    }
    if (progress < 1) {
      progress += FRAME_MSEC / targetEntry.animation_msec;
      setTimeout(animate, FRAME_MSEC);
    } else {
      targetEntry.statusDiv.css("z-index", 0);
      targetEntry.retweeterSpan.css("background-color", "#ffff40");
      targetEntry.retweeterSpan.animate({backgroundColor: "white"}, 1000);
      setTimeout(showEntryInQueue, FRAME_MSEC);
    }
  }
  animate();
  
}

function createView(entry) {
  var url = "https://twitter.com/" + entry.user.screen_name + "/status/" + entry.id_str;
  var userUrl = "https://twitter.com/" + entry.user.screen_name;
  struct =
    ["div", {className: "status", key: "statusDiv"},
      ["div", {className: "status-inner"},
        ["div", {className: "thumbnail"},
          ["a", {href: userUrl, target: "_blank"},
            ["img", {className: "thumbnail-img", src: entry.user.profile_image_url}]]],
        ["div", {className: "status-body"},
          ["div", {className: "status-content"},
            ["a", {className: "author", href: userUrl, target: "_blank"},
              entry.user.screen_name],
            " ",
            ["span", {className: "entry-content", key: "entryContentSpan"}]],
          ["div", {className: "meta"},
            ["div",
              ["a", {className: "entry-date", key: "dateAnchor", href: url, target: "_blank"},
                getDateStr(entry)],
              MESSAGES.beforeSource,
              ["span", {key: "sourceSpan"}],
              MESSAGES.afterSource],
            ["div",
              ["span", {key: "retweeterSpan"}]]]],
        ["div", {className: "status-footer"}]]];
  createElementTree(struct, entry);
  autoLink(entry.unescaped_text, entry.entryContentSpan);
  entry.sourceSpan.html(entry.unescaped_source);
}

function getEntryIndex(entry) {
  for (var i = 0; i < entries.length; ++i) {
    if (entries[i] == entry) return i;
  }
  return entries.length;
}

function updateDate(entry) {
  entry.dateAnchor.text(getDateStr(entry));
}

function updateTweetsPerSec() {
  var tps = getTweetsPerSec();
  if (tps > 0) {
    $("#tps").text("(" + tps.toFixed(2) + " " + MESSAGES.tps + ")");
  } else {
    $("#tps").empty();
  }
}

function getTweetsPerSec() {
  var allEntries = displayQue.concat(entries);
  var localNow = new Date().getTime();
  var oldestUpdatedAt = localNow;
  var numTweets = 0;
  for (var i = 0; i < allEntries.length; ++i) {
    numTweets += 1 + (allEntries[i].num_skipped || 0);
    oldestUpdatedAt = allEntries[i].local_updated_at;
  }
  var durationSec = (localNow - oldestUpdatedAt) / 1000;
  var tps = durationSec == 0 ? 0 : numTweets / durationSec;
  //console.log("tps", tps, numTweets, durationSec);
  return tps;
}

function focusOnUpdateField() {
  $("#update-field").focus();
  // Moves the caret to the beginning. Doesn't work on IE.
  $("#update-field").attr("selectionStart", 0);
  $("#update-field").attr("selectionEnd", 0);
}

// Streaming API output has "urls" information but it looks Search API output doesn't.
// So I use my hand-made pattern matching.
function autoLink(str, elem) {
  var exp =
      /(^|\s|[^\u0020-\u007f])(https?:\/\/[\x21-\x27\x2a-\x7f]+)|((\#[^\x00-\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f]+)|(@[a-zA-Z\d_]+))/g;
  var lastIndex = 0;
  var m;
  while (m = exp.exec(str)) {
    var text = str.substr(lastIndex, m.index - lastIndex);
    //console.log(text);
    appendText(elem, text);
    var prefix = m[1] || "";
    var url;
    var target;
    if (m[4]) {  // Hash tag
      text = m[4];
      url = "/search?q=" + encodeURIComponent(text) + "&hl=" + lang;
      target = "_self";
    } else if (m[5]) {  // User name
      text = m[5];
      url = "http://twitter.com/" + text.replace(/^@/, "");
      target = "_blank";
    } else if (m[2]) {  // URL
      text = m[2];
      url = text;
      target = "_blank";
    }
    //console.log(prefix, text, url, target);
    appendText(elem, prefix);
    elem.append(createElementTree(["a", {href: url, target: target}, text]));
    lastIndex = m.index + m[0].length;
  }
  var text = str.substr(lastIndex);
  //console.log(text);
  appendText(elem, text);
}

function appendText(elem, str) {
  elem.append(document.createTextNode(str));
}

function unescapeHtml(str) {
  return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">").
      replace(/&quot;/g, '"').replace(/&amp;/, "&");
}

function getDateStr(entry) {
  var secAgo = Math.floor((new Date().getTime() - entry.local_created_at) / 1000);
  if (secAgo == 1) {
    return MESSAGES.aSecondAgo;
  } else if (secAgo <= 5) {
    return MESSAGES.secondsAgo.replace("%d", secAgo);
  } else if (secAgo < 10) {
    return MESSAGES.lessThanSecondsAgo.replace("%d", 10);
  } else if (secAgo < 20) {
    return MESSAGES.lessThanSecondsAgo.replace("%d", 20);
  } else if (secAgo < 30) {
    return MESSAGES.lessThanSecondsAgo.replace("%d", 30);
  } else if (secAgo < 60) {
    return MESSAGES.lessThanAMinuteAgo;
  } else if (secAgo < 120) {
    return MESSAGES.aMinuteAgo;
  } else if (secAgo < 3600) {
    return MESSAGES.minutesAgo.replace("%d", Math.ceil(secAgo / 60));
  } else if (secAgo < 3600 * 2) {
    return MESSAGES.anHourAgo;
  } else {
    return MESSAGES.hoursAgo.replace("%d", Math.ceil(secAgo / 3600));
  }
}

function showBuzz() {
  $.ajax({
    url: "/buzz?hl=" + lang,
    dataType: "json",
    success: function(result) {
      $("#buzz").empty();
      for (var i = 0; i < result.length; ++i) {
        for (var j = 0; j < result[i].words.length; ++j) {
          var word = result[i].words[j];
          var url = "/search?q=" + encodeURIComponent(word) + "&hl=" + lang;
          $("#buzz").append(createElementTree(
            ["div",
              ["img", {className: "buzz-icon", src: "/images/" + result[i].lang_id + ".png"}],
              ["a", {href: url}, word]]));
        }
      }
    },
    error: function() {
      console.error("buzz fail");
    }
  });
}

function showError(message, show_retry_link, details) {
  console.error(message, details);
  var struct;
  if (message == "QUERY_NOT_HASH_TAGS" && details.suggested_query) {
    struct = ["span",
      MESSAGES.QUERY_NOT_HASH_TAGS_WITH_SUGGEST,
      ["a",
        {href: "/search?q=" + encodeURIComponent(details.suggested_query) + "&hl=" + lang},
        details.suggested_query]];
  } else if (message == "SEARCH_ERROR") {
    struct = MESSAGES.SEARCH_ERROR + " (" + details.error_detail + ")";
  } else {
    struct = MESSAGES[message] || message;
  }
  $("#error-message").empty();
  $("#error-message").append(createElementTree(struct));
  if (show_retry_link) {
    $("#retry-link").show();
  } else {
    $("#retry-link").hide();
  }
  $("#error-bar").show();
}