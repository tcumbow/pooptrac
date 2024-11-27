# Files to copy:
# - .\nodemon.json
# - .\package.json
# - .\package-lock.json
# - .\server.js
# - .\public\*.*

# Use RClone to sync the files to the server
# RClone remote path: pps:/home/tcumb/pooptrac

# RClone sync
rclone sync .\nodemon.json pps:/home/tcumb/pooptrac
rclone sync .\package.json pps:/home/tcumb/pooptrac
rclone sync .\package-lock.json pps:/home/tcumb/pooptrac
rclone sync .\server.js pps:/home/tcumb/pooptrac
rclone sync .\public\ pps:/home/tcumb/pooptrac/public
