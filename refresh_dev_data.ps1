# Files to copy:
# - .\db.json

# Use RClone to sync the files from the server
# RClone remote path: pps:/home/tcumb/pooptrac

# RClone sync
rclone sync pps:/home/tcumb/pooptrac/db.json .\
